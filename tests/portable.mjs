import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, readdir, lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from '../src/portable/build.mjs';
import {boundMemory} from '../src/portable/bounded-memory.mjs';
import {inspectWasm} from '../src/wasm.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputParent = path.join(projectRoot, '.test-output');
await mkdir(outputParent, {recursive: true});
const outputRoot = await mkdtemp(path.join(outputParent, 'portable-'));
const results = [];
const source = `#include <stdint.h>
int32_t signed32(int32_t a) { return a; }
uint32_t unsigned32(uint32_t a) { return a; }
int64_t signed64(int64_t a) { return a; }
uint64_t unsigned64(uint64_t a) { return a; }
float float32(float a, float b) { return a * b; }
double float64(double a, double b) { return a / b; }
void empty(void) {}
static int32_t hidden(int32_t a) { return a + 1; }
int32_t helper_user(int32_t a) { return hidden(a); }
`;
const declarations = [
  ['signed32', ['int32_t'], 'int32_t'], ['unsigned32', ['uint32_t'], 'uint32_t'],
  ['signed64', ['int64_t'], 'int64_t'], ['unsigned64', ['uint64_t'], 'uint64_t'],
  ['float32', ['float', 'float'], 'float'], ['float64', ['double', 'double'], 'double'],
  ['empty', [], 'void'], ['helper_user', ['int32_t'], 'int32_t'],
];
const cases = [
  ['signed32', [-2147483648], -2147483648], ['signed32', [2147483647], 2147483647],
  ['unsigned32', [4294967295], 4294967295],
  ['signed64', ['-9223372036854775808'], '-9223372036854775808'],
  ['signed64', ['9223372036854775807'], '9223372036854775807'],
  ['unsigned64', ['18446744073709551615'], '18446744073709551615'],
  ['float32', [1.5, 2.25], 3.375], ['float64', [22, 7], 22 / 7],
  ['empty', []], ['helper_user', [41], 42],
];
const spec = {
  name: 'portable-scalars', description: 'Verify each scalar ABI type with the portable compiler.',
  exports: declarations.map(([name, params, result]) => ({name, params: params.map((type, index) => ({name: `a${index}`, type})), result})),
  tests: cases.map(([name, args, expected]) => ({export: name, args, ...(expected === undefined ? {} : {expected})})),
};
const sourcePath = path.join(outputRoot, 'module.c.txt');
const specPath = path.join(outputRoot, 'module.spec.json');
const successPath = path.join(outputRoot, 'success');
await writeFile(sourcePath, source);
await writeFile(specPath, JSON.stringify(spec));
await build({source: sourcePath, spec: specPath, outDir: successPath});
const contract = JSON.parse(await readFile(path.join(successPath, 'contract.json'), 'utf8'));
assert.equal(contract.validation.tests_passed, cases.length);
assert.deepEqual(contract.imports, []);
assert.equal(contract.memory[0].maximum_pages, 256);
assert.deepEqual((await readdir(successPath)).sort(), ['contract.json', 'module.c', 'module.spec.json', 'module.wasm', 'verification.json']);
assert.equal(contract.exports.some((entry) => entry.name === 'hidden'), false);
results.push({name: 'all scalar types and boundary values', passed: true, tests: cases.length});

await assert.rejects(build({source: sourcePath, spec: specPath, outDir: successPath}), /already exists/);
results.push({name: 'existing output preserved', passed: true});

const failureSpec = {
  name: 'failure', description: 'A rejected portable build.',
  exports: [{name: 'add', params: [{name: 'a', type: 'int32_t'}], result: 'int32_t'}],
  tests: [{export: 'add', args: [2], expected: 3}],
};
const failures = [
  ['pointer', 'int32_t add(int32_t *a){return 3;}', /Conflicting|conflict|parameter|type|diagnostic/i],
  ['signedness', 'uint32_t add(uint32_t a){return a+1;}', /Conflicting|conflict|parameter|type|diagnostic/i],
  ['variadic', 'int32_t add(int32_t a,...){return a+1;}', /Conflicting|conflict|parameter|type|diagnostic/i],
  ['unresolved', 'int32_t missing(int32_t);int32_t add(int32_t a){return missing(a);}', /Unresolved|undefined|resolve/i],
  ['failed-example', 'int32_t add(int32_t a){return a+100;}', /failed: expected/i],
  ['execution-timeout', 'int32_t add(int32_t a){while(a>0){a+=0;}return a;}', /timed out/i],
  ['oversized-memory', 'char big[20000000];int32_t add(int32_t a){return big[a];}', /initial memory exceeds/i],
];
for (const [name, body, diagnostic] of failures) {
  const failedSource = path.join(outputRoot, `${name}.c.txt`);
  const failedSpec = path.join(outputRoot, `${name}.json`);
  const failedOutput = path.join(outputRoot, name);
  await writeFile(failedSource, '#include <stdint.h>\n' + body + '\n');
  await writeFile(failedSpec, JSON.stringify(failureSpec));
  await assert.rejects(build({source: failedSource, spec: failedSpec, outDir: failedOutput}), diagnostic);
  await assert.rejects(lstat(failedOutput), (error) => error.code === 'ENOENT');
  results.push({name, passed: true, output_not_published: true});
}
assert.equal((await readdir(outputRoot)).some((name) => name.startsWith('.wasm-build-')), false);

const original = await readFile(path.join(successPath, 'module.wasm'));
const tightened = boundMemory(original, 2);
assert.equal(inspectWasm(tightened).memories[0].maximum_pages, 2);
assert.equal(new WebAssembly.Instance(new WebAssembly.Module(tightened), {}).exports.helper_user(41), 42);
assert.deepEqual(boundMemory(tightened, 256), tightened, 'A larger limit must not loosen an existing memory maximum.');
const oversized = Buffer.from([0,97,115,109,1,0,0,0,5,4,1,0,172,2]); // Initial memory = 300 pages.
assert(WebAssembly.validate(oversized));
assert.throws(() => boundMemory(oversized, 256), /initial memory exceeds/);
const unbounded = Buffer.from([0,97,115,109,1,0,0,0,5,3,1,0,1]);
const bounded = boundMemory(unbounded, 256);
assert.equal(inspectWasm(bounded).memories[0].maximum_pages, 256);
results.push({name: 'memory maximum added and tightened; oversized memory rejected', passed: true});

await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify({passed: true, results}, null, 2) + '\n');
process.stdout.write(JSON.stringify({passed: true, output_dir: outputRoot, checks: results.length, results}, null, 2) + '\n');
