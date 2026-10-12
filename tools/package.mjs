import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'toolchains.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, i) => {
  for (let j = 0; j < 8; j++) i = (i >>> 1) ^ ((i & 1) ? 0xedb88320 : 0);
  return i >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
async function walk(dir, prefix = '') {
  const entries = [];
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) entries.push(...await walk(path.join(dir, entry.name), relative + '/'));
    else if (entry.isFile()) entries.push(relative);
    else throw new Error(`Only regular files are allowed in a skill package: ${relative}`);
  }
  return entries;
}

// Small ZIP writer: SDK archives are stored, text resources use raw DEFLATE.
// Fixed ZIP dates make repeated packages deterministic for identical inputs.
async function zipSkill(dir, output) {
  const skillName = path.basename(dir);
  const handle = await fs.open(output + '.tmp', 'w');
  const directory = [];
  let offset = 0;
  try {
    for (const relative of await walk(dir)) {
      const name = Buffer.from(`${skillName}/${relative}`, 'utf8');
      const data = await fs.readFile(path.join(dir, relative));
      const method = relative.endsWith('.tar.gz') ? 0 : 8;
      const compressed = method ? deflateRawSync(data, { level: 9 }) : data;
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(33, 12); // 1980-01-01
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x0314, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x800, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(33, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(compressed.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      central.writeUInt32LE(offset, 42);
      await handle.write(local);
      await handle.write(name);
      await handle.write(compressed);
      offset += local.length + name.length + compressed.length;
      directory.push(central, name);
    }
    const central = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(directory.length / 2, 8);
    end.writeUInt16LE(directory.length / 2, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    await handle.write(central);
    await handle.write(end);
  } finally { await handle.close(); }
  await fs.rename(output + '.tmp', output);
}

const selected = process.argv[2] || 'all';
if (!['all', 'x64', 'arm64'].includes(selected)) throw new Error('Usage: node tools/package.mjs [all|x64|arm64]');
const arches = selected === 'all' ? ['x64', 'arm64'] : [selected];
await fs.mkdir(path.join(root, 'dist'), { recursive: true });
const checksums = [];
for (const arch of arches) {
  const host = manifest.hosts[arch];
  const sdkFile = path.join(root, '.cache', host.archive);
  const sdkBytes = await fs.readFile(sdkFile);
  if (sdkBytes.length !== host.bytes || hash(sdkBytes) !== host.archiveSha256) throw new Error(`${host.archive}: checksum/size mismatch`);
  const dir = path.join(root, 'skills', `c-wasm-linux-${arch}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE.txt'));
  await fs.copyFile(path.join(root, 'NOTICE'), path.join(dir, 'NOTICE.txt'));
  for (const relative of await walk(path.join(root, 'template'))) {
    let text = await fs.readFile(path.join(root, 'template', relative), 'utf8');
    text = text.replaceAll('{{ARCH}}', arch).replaceAll('{{SDK_ARCH}}', arch === 'x64' ? 'x86_64' : 'arm64').replaceAll('{{SHA256}}', host.archiveSha256);
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), text);
  }
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  for (const name of ['build.mjs', 'wasm.mjs', 'verify.mjs', 'prepare.mjs']) await fs.copyFile(path.join(root, 'src', name), path.join(dir, 'scripts', name));
  await fs.copyFile(sdkFile, path.join(dir, 'toolchain', 'wasi-sdk.tar.gz'));
  await fs.writeFile(path.join(dir, 'host.json'), JSON.stringify({ platform: 'linux', arch, sdkVersion: manifest.sdkVersion, archiveSha256: host.archiveSha256 }, null, 2) + '\n');
  const archiveName = `c-wasm-linux-${arch}.zip`;
  const output = path.join(root, 'dist', archiveName);
  await zipSkill(dir, output);
  const outputBytes = await fs.readFile(output);
  checksums.push(`${hash(outputBytes)}  ${archiveName}`);
  console.log(JSON.stringify({ skill: dir, zip: output, bytes: outputBytes.length }));
}
await fs.writeFile(path.join(root, 'dist', 'SHA256SUMS' + (selected === 'all' ? '' : `-${selected}`)), checksums.join('\n') + '\n');
