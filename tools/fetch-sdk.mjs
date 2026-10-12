import * as fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'toolchains.json'), 'utf8'));
const selected = process.argv[2] || 'all';
if (!['all', 'x64', 'arm64'].includes(selected)) throw new Error('Usage: node tools/fetch-sdk.mjs [all|x64|arm64]');
await fs.mkdir(path.join(root, '.cache'), { recursive: true });
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
for (const arch of selected === 'all' ? ['x64', 'arm64'] : [selected]) {
  const item = manifest.hosts[arch];
  const file = path.join(root, '.cache', item.archive);
  try {
    if ((await fs.stat(file)).size === item.bytes && await digest(file) === item.archiveSha256) {
      console.log(`Verified cached ${item.archive}`);
      continue;
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${manifest.sdkVersion.split('.')[0]}/${item.archive}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`SDK download failed: ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file + '.part'));
  if ((await fs.stat(file + '.part')).size !== item.bytes || await digest(file + '.part') !== item.archiveSha256) {
    throw new Error(`SDK SHA-256/size mismatch: ${item.archive}`);
  }
  await fs.rename(file + '.part', file);
  console.log(`Downloaded and verified ${item.archive}`);
}
