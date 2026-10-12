import {parentPort, workerData} from 'node:worker_threads';
import {WASI} from 'node:wasi';
import {openSync, closeSync} from 'node:fs';
import path from 'node:path';

const descriptors = [];
try {
  for (const name of ['compiler.stdout', 'compiler.stderr']) descriptors.push(openSync(path.join(workerData.workPath, name), 'w'));
  const wasi = new WASI({
    version: 'preview1',
    args: ['/usr/bin/cc', ...workerData.args],
    env: {PWD: '/work', TMPDIR: '/tmp'},
    preopens: {'/usr/include': workerData.headerPath, '/work': workerData.workPath, '.': workerData.workPath, '/tmp': workerData.workPath},
    stdout: descriptors[0], stderr: descriptors[1],
    returnOnExit: true,
  });
  const module = new WebAssembly.Module(workerData.compilerBytes);
  const instance = new WebAssembly.Instance(module, wasi.getImportObject());
  parentPort.postMessage({ok: true, exitCode: wasi.start(instance)});
} catch (error) {
  parentPort.postMessage({ok: false, error: error.message});
} finally {
  for (const descriptor of descriptors) closeSync(descriptor);
}
