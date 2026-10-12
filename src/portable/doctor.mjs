import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {COMPILER_BASE64, COMPILER_SHA256, PROVENANCE} from './compiler-data.mjs';

async function doctor(selfTest) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const {WASI} = await import('node:wasi');
  const {Worker} = await import('node:worker_threads');
  if (typeof WASI !== 'function' || typeof Worker !== 'function') throw new Error('Node WASI and worker threads are required.');
  const bytes = Buffer.from(COMPILER_BASE64, 'base64');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== COMPILER_SHA256) throw new Error('Embedded compiler SHA-256 mismatch.');
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.some(entry => entry.module !== 'wasi_snapshot_preview1')) throw new Error('Unexpected compiler imports.');
  const result = {ready: true, node: process.versions.node, platform: process.platform, arch: process.arch,
    compiler: `${PROVENANCE.name} ${PROVENANCE.version}`, compiler_sha256: hash,
    requirements: 'Python 3.10+, Node.js 22+ with WASI and worker threads', self_test: 'not_requested'};
  if (selfTest) {
    const {build} = await import('./build.mjs');
    const scratch = await mkdtemp(path.join(tmpdir(), 'wcc-doctor-'));
    try {
      const skillRoot = fileURLToPath(new URL('../', import.meta.url));
      const output = await build({source: path.join(skillRoot, 'examples', 'module.c.txt'),
        spec: path.join(skillRoot, 'examples', 'module.spec.json'), outDir: path.join(scratch, 'result')});
      result.self_test = 'compile_and_verify_passed';
      result.artifacts = output.files;
    } finally {
      if (path.dirname(scratch) !== path.resolve(tmpdir()) || !path.basename(scratch).startsWith('wcc-doctor-')) throw new Error('Unsafe doctor cleanup path.');
      await rm(scratch, {recursive: true, force: true});
    }
  }
  return result;
}

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--self-test') || args.length > 1) throw new Error('Usage: doctor.mjs [--self-test]');
  process.stdout.write(JSON.stringify(await doctor(args.includes('--self-test')), null, 2) + '\n');
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
}
