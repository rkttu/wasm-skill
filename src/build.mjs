#!/usr/bin/env node
import {readFile, writeFile, mkdir, mkdtemp, lstat, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {C_TYPES, inspectWasm} from './wasm.mjs';
import {verifyModule} from './verify.mjs';
import {prepareToolchain} from './prepare.mjs';

const execute = promisify(execFile);
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_EXPORTS = 64;
const MAX_TESTS = 128;
const MAX_PARAMETERS = 16;
const C_KEYWORDS = new Set(('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local').split(' '));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label, allowed) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  for (const key of Object.keys(value)) assert(allowed.includes(key), `Unknown ${label} field: ${key}.`);
}

function text(value, label, maxLength, {allowEmpty = false} = {}) {
  assert(typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.trim().length > 0), `${label} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${maxLength} characters.`);
  return value;
}

function identifier(value, label) {
  text(value, label, 100);
  assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !C_KEYWORDS.has(value), `${label} must be a C identifier, not a keyword.`);
  assert(!value.startsWith('__'), `${label} must not use a reserved __ prefix.`);
  return value;
}

function scalar(value, type, label) {
  if (type === 'int64_t' || type === 'uint64_t') {
    assert(typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value) && value.length <= 21, `${label} must be an exact decimal string for ${type}.`);
    const number = BigInt(value);
    const min = type === 'int64_t' ? -(1n << 63n) : 0n;
    const max = type === 'int64_t' ? (1n << 63n) - 1n : (1n << 64n) - 1n;
    assert(number >= min && number <= max, `${label} is outside the ${type} range.`);
    return number.toString();
  }
  assert(typeof value === 'number' && Number.isFinite(value), `${label} must be a finite JSON number.`);
  if (type === 'int32_t' || type === 'uint32_t') {
    const min = type === 'int32_t' ? -2147483648 : 0;
    const max = type === 'int32_t' ? 2147483647 : 4294967295;
    assert(Number.isInteger(value) && value >= min && value <= max, `${label} is outside the ${type} integer range.`);
  } else if (type === 'float') {
    assert(Number.isFinite(Math.fround(value)), `${label} cannot be represented as a finite float.`);
  }
  return value;
}

/** Validate and normalize the model-written specification before compilation. */
export function normalizeSpec(input) {
  object(input, 'spec', ['name', 'description', 'exports', 'tests']);
  const spec = {
    name: text(input.name, 'spec.name', 200),
    description: text(input.description, 'spec.description', 4000),
    exports: [],
    tests: [],
  };
  assert(Array.isArray(input.exports) && input.exports.length > 0 && input.exports.length <= MAX_EXPORTS, `spec.exports must contain between 1 and ${MAX_EXPORTS} functions.`);
  const exportNames = new Set();
  for (const entry of input.exports) {
    object(entry, 'export', ['name', 'description', 'params', 'result']);
    const name = identifier(entry.name, 'export.name');
    assert(name !== 'memory', 'The export name memory is reserved for linear memory.');
    assert(!exportNames.has(name), `Duplicate export name: ${name}.`);
    exportNames.add(name);
    assert(Array.isArray(entry.params) && entry.params.length <= MAX_PARAMETERS, `Export ${name} must have at most ${MAX_PARAMETERS} parameters.`);
    const parameterNames = new Set();
    const params = entry.params.map((parameter) => {
      object(parameter, 'parameter', ['name', 'type']);
      const parameterName = identifier(parameter.name, `${name} parameter name`);
      assert(!parameterNames.has(parameterName), `Duplicate parameter name in ${name}: ${parameterName}.`);
      parameterNames.add(parameterName);
      assert(Object.hasOwn(C_TYPES, parameter.type), `Unsupported parameter type ${parameter.type} in ${name}.`);
      return {name: parameterName, type: parameter.type};
    });
    assert(entry.result === 'void' || Object.hasOwn(C_TYPES, entry.result), `Unsupported result type ${entry.result} in ${name}.`);
    const declaration = {name, params, result: entry.result};
    if (entry.description !== undefined) declaration.description = text(entry.description, `${name}.description`, 4000);
    spec.exports.push(declaration);
  }
  assert(Array.isArray(input.tests) && input.tests.length > 0 && input.tests.length <= MAX_TESTS, `spec.tests must contain between 1 and ${MAX_TESTS} cases.`);
  const covered = new Set();
  for (const [index, test] of input.tests.entries()) {
    object(test, `test ${index}`, ['export', 'args', 'expected', 'tolerance']);
    const declaration = spec.exports.find((entry) => entry.name === test.export);
    assert(declaration, `Test ${index} names an unknown export: ${test.export}.`);
    assert(Array.isArray(test.args) && test.args.length === declaration.params.length, `Test ${index} argument count does not match ${test.export}.`);
    const normalized = {
      export: test.export,
      args: test.args.map((value, i) => scalar(value, declaration.params[i].type, `Test ${index} argument ${i}`)),
    };
    if (declaration.result === 'void') {
      assert(!Object.hasOwn(test, 'expected'), `Void test ${index} must omit expected.`);
    } else {
      assert(Object.hasOwn(test, 'expected'), `Test ${index} must provide expected.`);
      normalized.expected = scalar(test.expected, declaration.result, `Test ${index} expected`);
    }
    if (Object.hasOwn(test, 'tolerance')) {
      assert(declaration.result === 'float' || declaration.result === 'double', `Test ${index} tolerance is only allowed for a floating-point result.`);
      assert(typeof test.tolerance === 'number' && Number.isFinite(test.tolerance) && test.tolerance >= 0 && test.tolerance <= 0.01, `Test ${index} tolerance must be a finite number between 0 and 0.01.`);
      normalized.tolerance = test.tolerance;
    }
    covered.add(test.export);
    spec.tests.push(normalized);
  }
  for (const name of exportNames) assert(covered.has(name), `Export ${name} needs at least one test.`);
  return spec;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function absent(filename) {
  try {
    await lstat(filename);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function prototypeHeader(spec) {
  return '#ifndef WASM_SKILL_GENERATED_CONTRACT_H\n#define WASM_SKILL_GENERATED_CONTRACT_H\n#include <stdint.h>\n' +
    spec.exports.map((entry) => `${entry.result} ${entry.name}(${entry.params.length ? entry.params.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ') : 'void'});`).join('\n') +
    '\n#endif\n';
}

function matchExports(spec, actual) {
  const functions = actual.exports.filter((entry) => entry.kind === 'function');
  assert(functions.length === spec.exports.length, 'Compiled function exports do not match the declared export set.');
  for (const entry of spec.exports) {
    const fn = functions.find((candidate) => candidate.name === entry.name);
    assert(fn, `Compiled module is missing export ${entry.name}.`);
    const params = entry.params.map((parameter) => C_TYPES[parameter.type]);
    const results = entry.result === 'void' ? [] : [C_TYPES[entry.result]];
    assert(JSON.stringify(fn.params) === JSON.stringify(params) && JSON.stringify(fn.results) === JSON.stringify(results), `Compiled Wasm signature does not match the spec for ${entry.name}.`);
  }
}

function diagnostic(error, action) {
  const details = String(error.stderr ?? error.stdout ?? error.message).trim();
  return new Error(`${action} failed${error.killed ? ' or exceeded its timeout' : ''}: ${details.slice(0, 12_000)}`);
}

/** Compile, inspect and execute tests; publish the fresh directory only on success. */
export async function build({source, spec: specFile, outDir, clang: clangOverride}) {
  assert(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js 22 or newer is required.');
  assert(typeof source === 'string' && typeof specFile === 'string' && typeof outDir === 'string', 'source, spec and outDir paths are required.');
  const sourcePath = path.resolve(source);
  const specPath = path.resolve(specFile);
  const outputPath = path.resolve(outDir);
  assert(path.extname(sourcePath).toLowerCase() === '.c', 'Source must be a .c file.');
  assert(await absent(outputPath), `Output directory already exists: ${outputPath}. Choose a fresh directory.`);
  const sourceBytes = await readFile(sourcePath);
  assert(sourceBytes.length > 0 && sourceBytes.length <= MAX_SOURCE_BYTES, 'C source must be nonempty and at most 256 KiB.');
  assert(!sourceBytes.includes(0), 'C source must not contain NUL bytes.');
  const specBytes = await readFile(specPath);
  assert(specBytes.length <= MAX_SPEC_BYTES, 'Specification must be at most 1 MiB.');
  let parsedSpec;
  try { parsedSpec = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(specBytes)); }
  catch (error) { throw new Error(`Cannot parse the UTF-8 JSON specification: ${error.message}`); }
  const spec = normalizeSpec(parsedSpec);
  const prepared = clangOverride ? null : await prepareToolchain();
  const clang = clangOverride ? path.resolve(clangOverride) : (typeof prepared === 'string' ? prepared : prepared.clang);
  assert(typeof clang === 'string' && clang.length > 0, 'Toolchain preparation did not provide a clang path.');
  let compilerVersion;
  try {
    const result = await execute(clang, ['--version'], {timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true});
    compilerVersion = result.stdout.split(/\r?\n/, 1)[0].trim();
  } catch (error) { throw diagnostic(error, 'Compiler version check'); }

  await mkdir(path.dirname(outputPath), {recursive: true});
  const tempPath = await mkdtemp(path.join(path.dirname(outputPath), '.wasm-build-'));
  try {
    const tempSource = path.join(tempPath, 'module.c');
    const headerPath = path.join(tempPath, 'generated-contract.h');
    const wasmPath = path.join(tempPath, 'module.wasm');
    await writeFile(tempSource, sourceBytes);
    await writeFile(headerPath, prototypeHeader(spec), 'utf8');
    const args = [
      '--no-default-config', '--target=wasm32-unknown-unknown', '-std=c11', '-O2', '-ffreestanding', '-fno-builtin', '-nostdlib', '-Werror',
      '-include', headerPath, tempSource, '-o', wasmPath,
      '-Wl,--no-entry', '-Wl,--export-memory', '-Wl,--max-memory=16777216',
      '-Wl,-z,stack-size=65536', '-Wl,--fatal-warnings',
      ...spec.exports.map((entry) => `-Wl,--export=${entry.name}`),
    ];
    try { await execute(clang, args, {cwd: tempPath, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true}); }
    catch (error) { throw diagnostic(error, 'C to Wasm compilation'); }
    const wasmBytes = await readFile(wasmPath);
    const actual = inspectWasm(wasmBytes);
    matchExports(spec, actual);
    const verification = await verifyModule(wasmBytes, spec);
    const contract = {
      schema_version: '0.1.0',
      name: spec.name,
      description: spec.description,
      module: {file: 'module.wasm', sha256: sha256(wasmBytes), bytes: wasmBytes.length, target: 'wasm32-unknown-unknown', abi: 'scalar-v1'},
      exports: spec.exports.map((entry) => {
        const fn = actual.exports.find((candidate) => candidate.name === entry.name);
        return {
          ...entry,
          params: entry.params.map((parameter) => ({...parameter, wasm_type: C_TYPES[parameter.type]})),
          wasm: {params: fn.params, results: fn.results},
        };
      }),
      imports: actual.imports,
      memory: actual.memories,
      build: {compiler: compilerVersion, source_sha256: sha256(sourceBytes), optimization: 'O2', host: {platform: process.platform, arch: process.arch}, compiler_override: Boolean(clangOverride)},
      validation: {binary_valid: true, exports_match: true, tests_passed: verification.tests.length},
    };
    const json = (value) => JSON.stringify(value, null, 2) + '\n';
    await writeFile(path.join(tempPath, 'module.spec.json'), json(spec), 'utf8');
    await writeFile(path.join(tempPath, 'contract.json'), json(contract), 'utf8');
    await writeFile(path.join(tempPath, 'verification.json'), json(verification), 'utf8');
    await rm(headerPath);
    assert(await absent(outputPath), `Output directory appeared during the build: ${outputPath}.`);
    await rename(tempPath, outputPath);
    return {out_dir: outputPath, files: ['module.wasm', 'module.c', 'module.spec.json', 'contract.json', 'verification.json']};
  } catch (error) {
    assert(path.dirname(tempPath) === path.dirname(outputPath) && path.basename(tempPath).startsWith('.wasm-build-'), 'Unsafe build cleanup path.');
    await rm(tempPath, {recursive: true, force: true});
    throw error;
  }
}

const HELP = `Usage: node scripts/build.mjs --source source.c --spec spec.json --out-dir fresh-directory [--clang /absolute/path/to/clang]\n\nCompiles a freestanding scalar C API to module.wasm, generates contract.json from\nthe actual binary, and publishes the output directory after all tests pass.\nThe default compiler is prepared from the skill's bundled Linux toolchain.\n--clang is an explicit development override for a compatible local compiler.\n`;

function parseArguments(argv) {
  const options = {};
  const keys = new Map([['--source', 'source'], ['--spec', 'spec'], ['--out-dir', 'outDir'], ['--clang', 'clang']]);
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return {help: true};
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
    else process.stdout.write(JSON.stringify(await build(options), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
