import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';

function toWasm(value, type) {
  return type === 'int64_t' || type === 'uint64_t' ? BigInt(value) : value;
}

function fromWasm(value, type) {
  if (type === 'void') return null;
  if (type === 'int64_t') return BigInt.asIntN(64, value).toString();
  if (type === 'uint64_t') return BigInt.asUintN(64, value).toString();
  if (type === 'uint32_t') return value >>> 0;
  return value;
}

function runTest(bytes, declaration, test) {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const fn = instance.exports[test.export];
  if (typeof fn !== 'function') throw new Error(`Missing function export ${test.export}.`);
  const args = test.args.map((value, i) => toWasm(value, declaration.params[i].type));
  const actual = fromWasm(fn(...args), declaration.result);
  const floatResult = declaration.result === 'float' || declaration.result === 'double';
  const tolerance = floatResult ? test.tolerance ?? (declaration.result === 'float' ? 1e-6 : 1e-12) : undefined;
  let passed;
  if (declaration.result === 'void') {
    passed = true;
  } else if (floatResult) {
    passed = Number.isFinite(actual) && Math.abs(actual - test.expected) <= tolerance * Math.max(1, Math.abs(test.expected));
  } else {
    passed = actual === test.expected;
  }
  const record = {export: test.export, args: test.args, actual, passed};
  if (declaration.result !== 'void') record.expected = test.expected;
  if (tolerance !== undefined) record.tolerance = tolerance;
  return record;
}

if (!isMainThread) {
  try {
    parentPort.postMessage({ok: true, result: runTest(workerData.bytes, workerData.declaration, workerData.test)});
  } catch (error) {
    parentPort.postMessage({ok: false, error: error.message});
  }
}

function isolatedTest(bytes, declaration, test, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {bytes, declaration, test},
      resourceLimits: {maxOldGenerationSizeMb: 64, stackSizeMb: 4},
    });
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Termination is requested even after a response so no generated code lingers.
      void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => settle(new Error(`Test for ${test.export} timed out after ${timeoutMs} ms.`)), timeoutMs);
    worker.once('message', (message) => {
      if (!message.ok) settle(new Error(`Test for ${test.export} trapped: ${message.error}`));
      else if (!message.result.passed) settle(new Error(`Test for ${test.export} failed: expected ${JSON.stringify(message.result.expected)}, received ${JSON.stringify(message.result.actual)}.`));
      else settle(null, message.result);
    });
    worker.once('error', (error) => settle(new Error(`Test worker for ${test.export} failed: ${error.message}`)));
    worker.once('exit', (code) => {
      if (!settled) settle(new Error(`Test worker for ${test.export} exited before reporting a result (code ${code}).`));
    });
  });
}

/** Every test receives a fresh instance; execution is bounded in a worker. */
export async function verifyModule(bytes, spec, {timeoutMs = 3000} = {}) {
  if (!isMainThread) throw new Error('verifyModule must run on the main thread.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid test timeout.');
  const records = [];
  for (const test of spec.tests) {
    const declaration = spec.exports.find((entry) => entry.name === test.export);
    if (!declaration) throw new Error(`Unknown test export ${test.export}.`);
    records.push(await isolatedTest(bytes, declaration, test, timeoutMs));
  }
  return {passed: true, isolation: 'fresh-instance-per-test', timeout_ms_per_test: timeoutMs, tests: records};
}
