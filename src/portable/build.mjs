#!/usr/bin/env node
import {readFile, writeFile, mkdir, mkdtemp, lstat, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {C_TYPES, inspectWasm} from '../wasm.mjs';
import {verifyModule} from '../verify.mjs';
import {normalizeSpec, prototypeHeader, matchExports} from './spec.mjs';
import {compileC, PROVENANCE} from './compiler.mjs';
import {boundMemory} from './bounded-memory.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
async function absent(filename) {
  try { await lstat(filename); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

/** Compile, inspect and execute tests; publish a fresh directory only on success. */
export async function build({source, spec: specFile, outDir}) {
  assert(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js 22 or newer is required.');
  assert(typeof source === 'string' && typeof specFile === 'string' && typeof outDir === 'string', 'source, spec and outDir paths are required.');
  const sourcePath = path.resolve(source);
  const specPath = path.resolve(specFile);
  const outputPath = path.resolve(outDir);
  assert(/\.c(?:\.txt)?$/i.test(sourcePath), 'Source must be a .c or .c.txt file.');
  assert(await absent(outputPath), `Output directory already exists: ${outputPath}. Choose a fresh directory.`);
  const sourceBytes = await readFile(sourcePath);
  assert(sourceBytes.length > 0 && sourceBytes.length <= 256 * 1024, 'C source must be nonempty and at most 256 KiB.');
  assert(!sourceBytes.includes(0), 'C source must not contain NUL bytes.');
  // Validate source encoding before the compiler sees any files.
  new TextDecoder('utf-8', {fatal: true}).decode(sourceBytes);
  const specBytes = await readFile(specPath);
  assert(specBytes.length <= 1024 * 1024, 'Specification must be at most 1 MiB.');
  let parsedSpec;
  try { parsedSpec = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(specBytes)); }
  catch (error) { throw new Error(`Cannot parse the UTF-8 JSON specification: ${error.message}`); }
  const spec = normalizeSpec(parsedSpec);
  await mkdir(path.dirname(outputPath), {recursive: true});
  const tempPath = await mkdtemp(path.join(path.dirname(outputPath), '.wasm-build-'));
  try {
    const wasmPath = path.join(tempPath, 'module.wasm');
    await writeFile(path.join(tempPath, 'module.c'), sourceBytes);
    await writeFile(path.join(tempPath, 'generated-contract.h'), prototypeHeader(spec), 'utf8');
    await writeFile(path.join(tempPath, 'compile.c'), '#include "generated-contract.h"\n#include "module.c"\n', 'utf8');
    const compiler = await compileC({workPath: tempPath, exports: spec.exports.map((entry) => entry.name)});
    const wasmBytes = boundMemory(await readFile(wasmPath), 256);
    await writeFile(wasmPath, wasmBytes);
    const actual = inspectWasm(wasmBytes);
    matchExports(spec, actual);
    const verification = await verifyModule(wasmBytes, spec);
    const contract = {
      schema_version: '0.1.0', name: spec.name, description: spec.description,
      module: {file: 'module.wasm', sha256: sha256(wasmBytes), bytes: wasmBytes.length, target: 'wasm32-unknown-unknown', abi: 'scalar-v1'},
      exports: spec.exports.map((entry) => {
        const fn = actual.exports.find((candidate) => candidate.name === entry.name);
        return {...entry, params: entry.params.map((parameter) => ({...parameter, wasm_type: C_TYPES[parameter.type]})), wasm: {params: fn.params, results: fn.results}};
      }),
      imports: actual.imports, memory: actual.memories,
      build: {compiler: `${compiler.name} version ${compiler.version}`, compiler_sha256: compiler.sha256, source_sha256: sha256(sourceBytes), optimization: 'none', backend: 'bundled-wasm-compiler', compiler_memory_maximum_bytes: compiler.memory_maximum_bytes, compiler_timeout_ms: compiler.timeout_ms, provenance: PROVENANCE, host: {platform: process.platform, arch: process.arch}},
      validation: {binary_valid: true, exports_match: true, tests_passed: verification.tests.length},
    };
    await writeFile(path.join(tempPath, 'module.spec.json'), json(spec), 'utf8');
    await writeFile(path.join(tempPath, 'contract.json'), json(contract), 'utf8');
    await writeFile(path.join(tempPath, 'verification.json'), json(verification), 'utf8');
    for (const name of ['generated-contract.h', 'compile.c', 'compiler.stdout', 'compiler.stderr']) await rm(path.join(tempPath, name));
    await rm(path.join(tempPath, 'compiler-include'), {recursive: true});
    assert(await absent(outputPath), `Output directory appeared during the build: ${outputPath}.`);
    await rename(tempPath, outputPath);
    return {out_dir: outputPath, files: ['module.wasm', 'module.c', 'module.spec.json', 'contract.json', 'verification.json']};
  } catch (error) {
    assert(path.dirname(tempPath) === path.dirname(outputPath) && path.basename(tempPath).startsWith('.wasm-build-'), 'Unsafe build cleanup path.');
    await rm(tempPath, {recursive: true, force: true});
    throw error;
  }
}

const HELP = 'Usage: node build.mjs --source source.c --spec spec.json --out-dir fresh-directory\n\nCompile a freestanding scalar C API with the bundled Wasm compiler and publish\nmodule.wasm, contract.json and verification results after all tests pass.\n';
function parseArguments(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return {help: true};
  const options = {};
  const keys = new Map([['--source', 'source'], ['--spec', 'spec'], ['--out-dir', 'outDir']]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys.get(argv[i]);
    assert(key, `Unknown option: ${argv[i]}. Use --help.`);
    assert(!Object.hasOwn(options, key), `Repeated option: ${argv[i]}.`);
    assert(i + 1 < argv.length && argv[i + 1].length > 0 && !argv[i + 1].startsWith('--'), `Missing value for ${argv[i]}.`);
    options[key] = argv[i + 1];
  }
  assert(options.source && options.spec && options.outDir, 'Required options: --source, --spec, --out-dir. Use --help.');
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else process.stdout.write(json(await build(options)));
  } catch (error) { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; }
}
