#!/usr/bin/env python3
"""Launch the bundled Wasm skill scripts using an existing Node.js runtime.

Requires Python 3.10+ and Node.js 22+. This launcher never installs software or
downloads a runtime. Relative input/output paths are resolved from the caller's
working directory before invoking the sibling JavaScript entry points.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


BUILD_TIMEOUT_SECONDS = 450
DOCTOR_TIMEOUT_SECONDS = 90
SCRIPTS_DIR = Path(__file__).resolve().parent

CAPABILITY_PROBE = r"""
import { WASI } from 'node:wasi';
import { Worker } from 'node:worker_threads';

const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
if (!WebAssembly.validate(bytes)) throw new Error('WebAssembly validation is unavailable.');
new WebAssembly.Instance(new WebAssembly.Module(bytes));
const wasi = new WASI({ version: 'preview1', args: [], env: {}, returnOnExit: true });
if (!wasi.wasiImport || typeof wasi.wasiImport.fd_write !== 'function') {
  throw new Error('WASI Preview 1 support is unavailable.');
}
const workerSource = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('ready');";
const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)), {
  execArgv: [],
});
await new Promise((resolve, reject) => {
  let replied = false;
  const timer = setTimeout(() => {
    void worker.terminate();
    reject(new Error('Worker capability probe timed out.'));
  }, 5000);
  worker.once('message', (message) => {
    replied = true;
    clearTimeout(timer);
    void worker.terminate();
    if (message !== 'ready') reject(new Error('Worker capability probe returned an invalid result.'));
    else resolve();
  });
  worker.once('error', (error) => { clearTimeout(timer); reject(error); });
  worker.once('exit', (code) => {
    clearTimeout(timer);
    if (!replied) reject(new Error(`Worker exited before reporting a result (code ${code}).`));
  });
});
process.stdout.write(JSON.stringify({
  node: process.versions.node, platform: process.platform, arch: process.arch,
  webassembly: true, wasi: true, workers: true,
}) + '\n');
"""


class LauncherError(Exception):
    """An expected launch failure that can be explained without a traceback."""


def _diagnostic(result: subprocess.CompletedProcess[str]) -> str:
    message = (result.stderr or result.stdout or "No diagnostic was returned.").strip()
    return message if len(message) <= 4000 else message[:4000] + "\n[diagnostic truncated]"


def _run(command: list[str], *, timeout: int, label: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="strict",
            shell=False,
            cwd=str(SCRIPTS_DIR),
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise LauncherError(f"{label} exceeded {timeout} seconds.") from error
    except UnicodeError as error:
        raise LauncherError(f"{label} returned output that is not valid UTF-8.") from error
    except OSError as error:
        raise LauncherError(f"Cannot run {label}: {error}.") from error


def discover_node(explicit: str | None) -> Path:
    candidate = explicit if explicit is not None else os.environ.get("WASM_SKILL_NODE")
    if candidate:
        origin = "--node" if explicit is not None else "WASM_SKILL_NODE"
        executable = Path(candidate).expanduser()
        if not executable.is_absolute():
            raise LauncherError(f"{origin} must specify an absolute path to the Node.js executable.")
    elif explicit is not None:
        raise LauncherError("--node must specify a Node.js executable path.")
    else:
        found = shutil.which("node") or shutil.which("nodejs")
        if not found:
            raise LauncherError(
                "Node.js 22 or newer was not found. Provide --node /absolute/path/to/node, "
                "set WASM_SKILL_NODE, or make an existing Node.js runtime available on PATH."
            )
        executable = Path(found)
    try:
        executable = executable.resolve()
        if not executable.is_file():
            raise LauncherError(f"Node.js executable was not found: {executable}.")
        if not os.access(executable, os.X_OK):
            raise LauncherError(f"Node.js executable is not executable: {executable}.")
    except (OSError, RuntimeError) as error:
        raise LauncherError(f"Cannot resolve the Node.js executable: {error}.") from error
    return executable


def probe_node(executable: Path) -> dict:
    version = _run([str(executable), "--version"], timeout=10, label="Node.js version probe")
    if version.returncode != 0:
        raise LauncherError(f"Node.js version probe failed: {_diagnostic(version)}")
    match = re.match(r"^v([0-9]+)\.", version.stdout.strip())
    if not match:
        raise LauncherError("The selected executable did not return a recognizable Node.js version.")
    if int(match.group(1)) < 22:
        raise LauncherError(f"Node.js 22 or newer is required; found {version.stdout.strip()}.")
    result = _run(
        [str(executable), "--no-warnings", "--input-type=module", "--eval", CAPABILITY_PROBE],
        timeout=15,
        label="Node.js capability probe",
    )
    if result.returncode != 0:
        raise LauncherError(f"Node.js capability probe failed: {_diagnostic(result)}")
    try:
        capabilities = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError) as error:
        raise LauncherError("Node.js capability probe did not return valid JSON.") from error
    if not isinstance(capabilities, dict) or not all(
        capabilities.get(key) is True for key in ("webassembly", "wasi", "workers")
    ):
        raise LauncherError("The Node.js runtime must support WebAssembly, node:wasi, and Workers.")
    return capabilities


def arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the bundled Wasm skill with an existing Node.js 22+ runtime."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    doctor = commands.add_parser("doctor", help="Check the runtime and bundled compiler.")
    doctor.add_argument("--node", help="Absolute path to an existing Node.js executable.")
    doctor.add_argument("--self-test", action="store_true", help="Also compile and execute the bundled smoke test.")
    build = commands.add_parser("build", help="Compile C, verify its contract, and publish a fresh output directory.")
    build.add_argument("--source", required=True, help="Path to the C source file.")
    build.add_argument("--spec", required=True, help="Path to its contract JSON specification.")
    build.add_argument("--out-dir", required=True, help="Fresh output directory; existing directories are rejected.")
    build.add_argument("--node", help="Absolute path to an existing Node.js executable.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 10):
        sys.stderr.write("Error: Python 3.10 or newer is required.\n")
        return 1
    args = arguments(argv)
    try:
        node = discover_node(args.node)
        probe_node(node)
        script = SCRIPTS_DIR / f"{args.command}.mjs"
        if not script.is_file():
            raise LauncherError(f"Bundled script is missing: {script.name}.")
        command = [str(node), "--no-warnings", str(script)]
        if args.command == "doctor":
            if args.self_test:
                command.append("--self-test")
            timeout = DOCTOR_TIMEOUT_SECONDS
        else:
            for option, value in (("--source", args.source), ("--spec", args.spec), ("--out-dir", args.out_dir)):
                command.extend([option, str(Path(value).resolve())])
            timeout = BUILD_TIMEOUT_SECONDS
        result = _run(command, timeout=timeout, label=f"Node.js {args.command}")
        if result.stdout:
            sys.stdout.write(result.stdout)
        if result.stderr:
            sys.stderr.write(result.stderr)
        if result.returncode != 0 and not result.stderr.strip():
            sys.stderr.write(f"Error: Node.js {args.command} exited with code {result.returncode}.\n")
        return result.returncode if 0 <= result.returncode <= 125 else 1
    except (LauncherError, OSError, RuntimeError) as error:
        sys.stderr.write(f"Error: {error}\n")
        return 1
    except UnicodeError:
        sys.stderr.write("Error: The console cannot represent the script output as text.\n")
        return 1
    except KeyboardInterrupt:
        sys.stderr.write("Error: Interrupted.\n")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
