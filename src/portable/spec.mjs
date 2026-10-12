import {C_TYPES} from '../wasm.mjs';
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

export function prototypeHeader(spec) {
  return '#ifndef WASM_SKILL_GENERATED_CONTRACT_H\n#define WASM_SKILL_GENERATED_CONTRACT_H\n#include <stdint.h>\n' +
    spec.exports.map((entry) => `${entry.result} ${entry.name}(${entry.params.length ? entry.params.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ') : 'void'});`).join('\n') +
    '\n#endif\n';
}

export function matchExports(spec, actual) {
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


