import {Worker} from 'node:worker_threads';
import {mkdir, writeFile, open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {boundMemory} from './bounded-memory.mjs';
import {COMPILER_BASE64, COMPILER_SHA256, HEADERS, PROVENANCE} from './compiler-data.mjs';

export {PROVENANCE};
const MEMORY_MAXIMUM_PAGES = 4096; // 256 MiB for compiler execution.
const TIMEOUT_MS = 30_000;
const DIAGNOSTIC_LIMIT = 12_000;

async function diagnostic(filename) {
  const handle = await open(filename, 'r');
  try {
    const data = Buffer.alloc(DIAGNOSTIC_LIMIT);
    const {bytesRead} = await handle.read(data, 0, data.length, 0);
    return data.subarray(0, bytesRead).toString('utf8').trim();
  } finally { await handle.close(); }
}

function runCompiler(compilerBytes, workPath, headerPath, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./compiler-worker.mjs', import.meta.url), {
      workerData: {compilerBytes, workPath, headerPath, args},
      resourceLimits: {maxOldGenerationSizeMb: 64, stackSizeMb: 4},
    });
    let settled = false;
    const settle = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Wait for termination before callers remove the compiler's open files.
      await worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { void settle(new Error(`C to Wasm compilation exceeded ${TIMEOUT_MS} ms.`)); }, TIMEOUT_MS);
    worker.once('message', (message) => { void settle(message.ok ? null : new Error(`Compiler execution failed: ${message.error}`), message.exitCode); });
    worker.once('error', (error) => { void settle(new Error(`Compiler worker failed: ${error.message}`)); });
    worker.once('exit', (code) => { if (!settled) void settle(new Error(`Compiler worker exited before reporting its result (code ${code}).`)); });
  });
}

/** Run the bundled Wasm compiler using only Node's built-in WASI support. */
export async function compileC({workPath, exports}) {
  const original = Buffer.from(COMPILER_BASE64, 'base64');
  const digest = createHash('sha256').update(original).digest('hex');
  if (digest !== COMPILER_SHA256) throw new Error('Bundled compiler SHA-256 mismatch.');
  const compilerBytes = boundMemory(original, MEMORY_MAXIMUM_PAGES);
  const headerPath = path.join(workPath, 'compiler-include');
  await mkdir(headerPath);
  for (const [name, contents] of Object.entries(HEADERS)) {
    if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..') || path.isAbsolute(name)) throw new Error('Invalid bundled header path.');
    const target = path.join(headerPath, ...name.split('/'));
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, contents, 'utf8');
  }
  const args = ['-nostdlib', '--entry-point=', '--stack-size=65536', '-e', exports.join(','), '-o', '/work/module.wasm', '/work/compile.c'];
  const exitCode = await runCompiler(compilerBytes, workPath, headerPath, args);
  const stderr = await diagnostic(path.join(workPath, 'compiler.stderr'));
  const stdout = await diagnostic(path.join(workPath, 'compiler.stdout'));
  if (exitCode !== 0) throw new Error(`C to Wasm compilation failed (code ${exitCode}): ${stderr || stdout || 'Compiler reported no diagnostic.'}`);
  // A warning can signal an incompatible declaration in this small compiler.
  if (stderr) throw new Error(`C to Wasm compilation produced diagnostics: ${stderr}`);
  return {name: 'wcc', version: PROVENANCE.version ?? '0.1.13', sha256: COMPILER_SHA256, memory_maximum_bytes: MEMORY_MAXIMUM_PAGES * 65536, timeout_ms: TIMEOUT_MS};
}
