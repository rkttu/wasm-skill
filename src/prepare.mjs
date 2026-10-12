import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareToolchain() {
  const host = JSON.parse(await fs.readFile(path.join(skillRoot, 'host.json'), 'utf8'));
  if (host.platform !== 'linux' || !['x64', 'arm64'].includes(host.arch)) {
    throw new Error('Invalid skill host configuration.');
  }
  if (process.platform !== host.platform || process.arch !== host.arch) {
    throw new Error(`This skill requires Linux ${host.arch}; current Node host is ${process.platform} ${process.arch}. Use the matching skill package.`);
  }
  if (!/^[a-f0-9]{64}$/.test(host.archiveSha256)) throw new Error('Invalid SDK checksum.');
  const archive = path.join(skillRoot, 'toolchain', 'wasi-sdk.tar.gz');
  if (await sha256(archive) !== host.archiveSha256) throw new Error('Bundled SDK SHA-256 mismatch.');
  const cacheParent = path.resolve(process.env.WASM_SKILL_CACHE || path.join(os.tmpdir(), 'c-wasm-skills'));
  await fs.mkdir(cacheParent, { recursive: true });
  const cache = path.join(cacheParent, `sdk-${host.sdkVersion}-linux-${host.arch}-${host.archiveSha256.slice(0, 16)}`);
  const clang = path.join(cache, 'bin', 'clang');
  let ready = false;
  try {
    ready = (await fs.readFile(path.join(cache, '.archive-sha256'), 'utf8')).trim() === host.archiveSha256;
    if (ready) await fs.access(clang);
  } catch { ready = false; }
  if (!ready) {
    try {
      await fs.lstat(cache);
      throw new Error(`Incomplete SDK cache exists at ${cache}. Set WASM_SKILL_CACHE to a fresh directory.`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const temp = await fs.mkdtemp(path.join(cacheParent, '.extract-'));
    try {
      await exec('tar', ['-xzf', archive, '-C', temp, '--strip-components=1'], { timeout: 120_000, maxBuffer: 1024 * 1024 });
      await fs.access(path.join(temp, 'bin', 'clang'));
      await fs.writeFile(path.join(temp, '.archive-sha256'), host.archiveSha256 + '\n');
      try { await fs.rename(temp, cache); }
      catch (e) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e;
        if ((await fs.readFile(path.join(cache, '.archive-sha256'), 'utf8')).trim() !== host.archiveSha256) throw e;
      }
    } finally {
      // This path is created by mkdtemp directly under the selected cache parent.
      if (path.dirname(temp) !== cacheParent || !path.basename(temp).startsWith('.extract-')) throw new Error('Unsafe extraction cleanup path.');
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  try {
    await exec(clang, ['--version'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  } catch (e) {
    throw new Error(`Bundled Clang cannot run on this Linux host. Use a glibc-based distribution with compatible system libraries. ${e.message}`);
  }
  return clang;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareToolchain().then(clang => console.log(JSON.stringify({ ready: true, clang })))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
