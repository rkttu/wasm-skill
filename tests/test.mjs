import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectWasm } from '../src/wasm.mjs';
import { normalizeSpec } from '../src/build.mjs';
import { verifyModule } from '../src/verify.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const buildScript = join(repo, 'src', 'build.mjs');
const clang = process.env.WASM_SKILL_TEST_CLANG;
const integration = { skip: clang ? false : 'Set WASM_SKILL_TEST_CLANG to a compatible native Clang executable.' };

function uleb(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
}

const utf8 = (value) => [...Buffer.from(value, 'utf8')];
const wasmName = (value) => [...uleb(utf8(value).length), ...utf8(value)];
const section = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];
const wasm = (...sections) => Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
const addModule = (custom = []) => wasm(
  ...custom,
  section(1, [1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
  section(3, [1, 0]),
  section(7, [1, ...wasmName('add'), 0, 0]),
  section(10, [1, 7, 0, 0x20, 0, 0x20, 1, 0x6a, 0x0b]),
);

function addSpec(overrides = {}) {
  return {
    name: 'addition',
    description: 'Adds two signed 32-bit integers.',
    exports: [{ name: 'add', params: [{ name: 'a', type: 'int32_t' }, { name: 'b', type: 'int32_t' }], result: 'int32_t' }],
    tests: [{ export: 'add', args: [2, 3], expected: 5 }],
    ...overrides,
  };
}

function fixture(t, source, spec = addSpec()) {
  const dir = mkdtempSync(join(tmpdir(), 'wasm-skill-tests-'));
  t.after(() => {
    assert.ok(basename(resolve(dir)).startsWith('wasm-skill-tests-'));
    assert.equal(resolve(dir, '..'), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  const sourcePath = join(dir, 'input.c');
  const specPath = join(dir, 'spec.json');
  const outDir = join(dir, 'output');
  writeFileSync(sourcePath, source);
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  return { dir, sourcePath, specPath, outDir, source, spec };
}

function build(fx, extraArgs = []) {
  return spawnSync(process.execPath, [
    buildScript,
    '--source', fx.sourcePath,
    '--spec', fx.specPath,
    '--out-dir', fx.outDir,
    '--clang', clang,
    ...extraArgs,
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true, cwd: repo });
}

function assertFailedBuild(result, fx) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `Unexpected success: ${result.stdout}`);
  assert.ok(result.stderr.trim(), 'Failure should include a diagnostic.');
  assert.equal(existsSync(fx.outDir), false, 'A failed build must not publish its output directory.');
}

test('Wasm inspection reads scalar function ABI', () => {
  const bytes = addModule();
  assert.ok(WebAssembly.validate(bytes));
  const result = inspectWasm(bytes);
  const add = result.exports.find((entry) => entry.name === 'add');
  assert.equal(add.kind, 'function');
  assert.deepEqual(add.params, ['i32', 'i32']);
  assert.deepEqual(add.results, ['i32']);
  assert.deepEqual(result.imports, []);
});

test('valid custom sections do not change the inspected ABI', () => {
  const bytes = addModule([
    section(0, [...wasmName('poc-note'), ...utf8('contract test')]),
    section(0, [...wasmName(''), 0, 255]),
  ]);
  assert.ok(WebAssembly.validate(bytes));
  assert.deepEqual(inspectWasm(bytes), inspectWasm(addModule()));
});

test('invalid magic, truncated sections, and oversized LEB encodings are rejected', () => {
  const invalidMagic = addModule();
  invalidMagic[0] = 1;
  for (const bytes of [
    invalidMagic,
    wasm([0, 4, 1, 65]),
    wasm([0, 0x80, 0x80, 0x80, 0x80, 0x80, 0]),
    addModule().slice(0, -1),
  ]) {
    assert.throws(() => inspectWasm(bytes));
  }
});

test('Wasm imports are rejected even when their binary is valid', () => {
  const bytes = wasm(
    section(1, [1, 0x60, 0, 1, 0x7f]),
    section(2, [1, ...wasmName('env'), ...wasmName('host'), 0, 0]),
  );
  assert.ok(WebAssembly.validate(bytes));
  assert.throws(() => inspectWasm(bytes), /import/i);
});

test('Wasm start functions are rejected before instantiation', () => {
  const bytes = wasm(
    section(1, [1, 0x60, 0, 0]),
    section(3, [1, 0]),
    section(8, [0]),
    section(10, [1, 2, 0, 0x0b]),
  );
  assert.ok(WebAssembly.validate(bytes));
  assert.throws(() => inspectWasm(bytes), /start/i);
});

test('excessive Wasm memory limits are rejected', () => {
  const bytes = wasm(section(5, [1, 1, ...uleb(1), ...uleb(257)]));
  assert.ok(WebAssembly.validate(bytes));
  assert.throws(() => inspectWasm(bytes), /memory|pages|limit/i);
});

test('contract specifications reject pointer types and duplicate exports', () => {
  const pointer = addSpec();
  pointer.exports[0].params[0].type = 'int32_t*';
  assert.throws(() => normalizeSpec(pointer), /type|scalar|pointer/i);
  const duplicate = addSpec();
  duplicate.exports.push(structuredClone(duplicate.exports[0]));
  assert.throws(() => normalizeSpec(duplicate), /duplicate/i);
});

test('contract specifications reject unsafe numeric i64 arguments', () => {
  const spec = addSpec({
    exports: [{ name: 'add', params: [{ name: 'a', type: 'int64_t' }], result: 'int64_t' }],
    tests: [{ export: 'add', args: [9007199254740992], expected: '9007199254740992' }],
  });
  assert.throws(() => normalizeSpec(spec), /safe|integer|64|number/i);
});

test('Wasm verification executes a scalar test and records the result', async () => {
  const result = await verifyModule(addModule(), addSpec());
  assert.equal(result.passed, true);
  assert.equal(result.tests[0].actual, 5);
  assert.equal(result.tests[0].passed, true);
});

test('Wasm verification rejects an incorrect expected result', async () => {
  await assert.rejects(
    verifyModule(addModule(), addSpec({ tests: [{ export: 'add', args: [2, 3], expected: 6 }] })),
    /failed|expected/i,
  );
});

test('each verification case receives a fresh Wasm instance', async () => {
  const bytes = wasm(
    section(1, [1, 0x60, 0, 1, 0x7f]),
    section(3, [1, 0]),
    section(6, [1, 0x7f, 1, 0x41, 0, 0x0b]),
    section(7, [1, ...wasmName('bump'), 0, 0]),
    section(10, [1, 11, 0, 0x23, 0, 0x41, 1, 0x6a, 0x24, 0, 0x23, 0, 0x0b]),
  );
  assert.ok(WebAssembly.validate(bytes));
  const spec = addSpec({
    exports: [{ name: 'bump', params: [], result: 'int32_t' }],
    tests: [{ export: 'bump', args: [], expected: 1 }, { export: 'bump', args: [], expected: 1 }],
  });
  const result = await verifyModule(bytes, spec);
  assert.deepEqual(result.tests.map((entry) => entry.actual), [1, 1]);
});

test('Wasm verification terminates an infinite loop in its worker', async () => {
  const bytes = wasm(
    section(1, [1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
    section(3, [1, 0]),
    section(7, [1, ...wasmName('add'), 0, 0]),
    section(10, [1, 8, 0, 0x03, 0x40, 0x0c, 0, 0x0b, 0, 0x0b]),
  );
  assert.ok(WebAssembly.validate(bytes));
  await assert.rejects(verifyModule(bytes, addSpec(), { timeoutMs: 100 }), /timeout|timed out|exceeded/i);
});

test('actual C build publishes matching binary hash, ABI, and verification evidence', integration, (t) => {
  const spec = {
    name: 'scalar_abi',
    description: 'Verifies all supported scalar C ABI types.',
    exports: [
      { name: 'add', params: [{ name: 'a', type: 'int32_t' }, { name: 'b', type: 'int32_t' }], result: 'int32_t' },
      { name: 'unsigned_max', params: [], result: 'uint32_t' },
      { name: 'signed_step', params: [{ name: 'value', type: 'int64_t' }], result: 'int64_t' },
      { name: 'unsigned_step', params: [{ name: 'value', type: 'uint64_t' }], result: 'uint64_t' },
      { name: 'half', params: [{ name: 'value', type: 'float' }], result: 'float' },
      { name: 'fraction', params: [{ name: 'value', type: 'double' }], result: 'double' },
      { name: 'noop', params: [], result: 'void' },
    ],
    tests: [
      { export: 'add', args: [-7, 2], expected: -5 },
      { export: 'unsigned_max', args: [], expected: 4294967295 },
      { export: 'signed_step', args: ['-9223372036854775807'], expected: '-9223372036854775808' },
      { export: 'unsigned_step', args: ['18446744073709551614'], expected: '18446744073709551615' },
      { export: 'half', args: [3], expected: 1.5 },
      { export: 'fraction', args: [1], expected: 0.3333333333333333, tolerance: 1e-12 },
      { export: 'noop', args: [] },
    ],
  };
  const fx = fixture(t, `#include <stdint.h>\n
int32_t add(int32_t a, int32_t b) { return a + b; }
uint32_t unsigned_max(void) { return UINT32_MAX; }
int64_t signed_step(int64_t value) { return value - 1; }
uint64_t unsigned_step(uint64_t value) { return value + 1; }
float half(float value) { return value * 0.5f; }
double fraction(double value) { return value / 3.0; }
void noop(void) {}
`, spec);
  const result = build(fx);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const bytes = readFileSync(join(fx.outDir, 'module.wasm'));
  const contract = JSON.parse(readFileSync(join(fx.outDir, 'contract.json'), 'utf8'));
  const verification = JSON.parse(readFileSync(join(fx.outDir, 'verification.json'), 'utf8'));
  assert.ok(WebAssembly.validate(bytes));
  assert.equal(contract.schema_version, '0.1.0');
  assert.equal(contract.module.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(verification.passed, true);
  assert.equal(verification.tests.length, spec.tests.length);
  assert.ok(verification.tests.every((entry) => entry.passed === true));
  for (const entry of spec.exports) {
    const metadata = contract.exports.find((candidate) => candidate.name === entry.name);
    assert.ok(metadata, `Missing metadata for ${entry.name}`);
    assert.equal(metadata.result, entry.result);
    assert.deepEqual(metadata.params.map(({ name, type }) => ({ name, type })), entry.params);
    const exported = inspectWasm(bytes).exports.find((candidate) => candidate.name === entry.name);
    assert.deepEqual(metadata.wasm.params, exported.params);
    assert.deepEqual(metadata.wasm.results, exported.results);
  }
  for (const name of ['module.c', 'module.spec.json']) assert.ok(existsSync(join(fx.outDir, name)), `Missing ${name}`);
});

test('actual C build rejects a pointer ABI hidden behind an i32 Wasm signature', integration, (t) => {
  const spec = addSpec({
    exports: [{ name: 'read_pointer', params: [{ name: 'pointer', type: 'uint32_t' }], result: 'int32_t' }],
    tests: [{ export: 'read_pointer', args: [0], expected: 0 }],
  });
  const fx = fixture(t, '#include <stdint.h>\nint32_t read_pointer(const int32_t *pointer) { return *pointer; }\n', spec);
  assertFailedBuild(build(fx), fx);
});

test('actual C build fails for an unresolved external function', integration, (t) => {
  const fx = fixture(t, '#include <stdint.h>\nextern int32_t unknown(int32_t);\nint32_t add(int32_t a, int32_t b) { return unknown(a) + b; }\n');
  assertFailedBuild(build(fx), fx);
});

test('actual C build rejects an explicit host import', integration, (t) => {
  const fx = fixture(t, '#include <stdint.h>\n__attribute__((import_module("env"), import_name("host"))) extern int32_t host(int32_t);\nint32_t add(int32_t a, int32_t b) { return host(a) + b; }\n');
  const result = build(fx);
  assertFailedBuild(result, fx);
  assert.match(result.stderr, /import/i);
});

test('a failed expected value publishes no artifacts', integration, (t) => {
  const fx = fixture(t, '#include <stdint.h>\nint32_t add(int32_t a, int32_t b) { return a + b; }\n', addSpec({ tests: [{ export: 'add', args: [2, 3], expected: 6 }] }));
  assertFailedBuild(build(fx), fx);
});

test('an infinite C function reaches the runtime timeout and publishes no artifacts', integration, (t) => {
  const fx = fixture(t, '#include <stdint.h>\nint32_t add(int32_t a, int32_t b) { (void)a; (void)b; for (;;) {} }\n');
  const result = build(fx);
  assertFailedBuild(result, fx);
  assert.match(result.stderr, /timeout|timed out|exceeded \d+ ms/i);
});

test('invalid C source publishes no artifacts', integration, (t) => {
  const fx = fixture(t, '#include <stdint.h>\nint32_t add(int32_t a, int32_t b) { this is not valid C; }\n');
  assertFailedBuild(build(fx), fx);
});

test('an existing output directory is preserved and rejected', integration, (t) => {
  const fx = fixture(t, '#include <stdint.h>\nint32_t add(int32_t a, int32_t b) { return a + b; }\n');
  mkdirSync(fx.outDir);
  const sentinel = join(fx.outDir, 'keep.txt');
  writeFileSync(sentinel, 'keep me');
  const result = build(fx);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep me');
  assert.equal(existsSync(join(fx.outDir, 'module.wasm')), false);
});
