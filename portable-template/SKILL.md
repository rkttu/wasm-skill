---
name: c-wasm-portable-wcc
description: Generate C functions from a user request, compile them to portable Wasm with the embedded wcc compiler, and deliver verified contract metadata. Uses a Python entrypoint with Node.js; suitable for compact skill bundles.
---

# Generate C, Wasm, and a contract

Translate the user's computation into a single freestanding C source and a JSON spec, then run the bundled Python entrypoint. Deliver the compiled `module.wasm` and generated `contract.json`, with verification evidence and source when useful. The script handles compilation; the invoking model writes C. Here, contract means module interface metadata, not a blockchain contract.

## Check the runtime

Resolve the actual extracted skill directory from the host's provided resources. Use its absolute path below as `SKILL`. Run `doctor --self-test` once in the current execution context and reuse a successful result while the skill and runtime remain unchanged. Use the host's Python execution tool or shell:

```sh
python3 "$SKILL/scripts/run.py" doctor --self-test
```

Requires Python 3.10+ and Node.js 22+ with built-in WASI and worker threads. The Python script finds `node` or `nodejs` on PATH. If the host provides a Node executable elsewhere, supply `--node /absolute/path/to/node` or the `WASM_SKILL_NODE` environment variable. When only Python code execution is available, invoke the entrypoint through Python:

```python
import subprocess, sys
result = subprocess.run(
    [sys.executable, skill_dir + "/scripts/run.py", "doctor", "--self-test"],
    capture_output=True, text=True, timeout=90,
)
print(result.stdout)
print(result.stderr)
```

If diagnostics fail, report the observed missing capability and provide the source/spec as a draft if useful. Compilation and contract validation require a successful script run. Do not claim generated binaries exist without that run. The bundle includes the compiler and headers as JavaScript data, needs no npm/pip packages or downloads, and is shared by Linux x64 and arm64. Copilot Studio upload and runtime execution must still be tested in the user's tenant.

## Build the requested computation

Read [references/contract.md](references/contract.md) for spec fields, scalar types, and test rules. Use the verified C profile in [references/c-syntax.md](references/c-syntax.md) before generating source. Write a `.c` source and matching `.json` spec into the host's writable working directory. The bundled [examples/module.c.txt](examples/module.c.txt) and [examples/module.spec.json](examples/module.spec.json) show the format. The builder accepts `.c` or `.c.txt` input and preserves the source bytes in `module.c`.

For file creation, prefer the host's file creation/editing tool or Python `Path.write_text(..., encoding="utf-8")` and `json.dumps`; invoke `run.py` through `subprocess.run` with an argument list. A complete Python example is in [references/authoring.md](references/authoring.md). Shell heredoc parsing depends on the host shell and command wrapper. If file creation fails, fix that layer before changing C code; the log phrase "heredoc parsing" does not establish a C comment error.

Public parameter/return types: `int32_t`, `uint32_t`, `int64_t`, `uint64_t`, `float`, `double`; `void` is permitted as a return. Encode 64-bit test integers as decimal strings. Export each requested public function and include examples covering normal cases and meaningful boundary cases. Avoid signed overflow in C. Public pointers, strings, arrays, structs, variadic arguments, and dependencies on libc/WASI functions are outside this MVP.

Use self-contained C with fixed-width types from `<stdint.h>`. The default profile is scalar variables/casts, arithmetic/bitwise/comparison/logical operators, `if/else`, `?:`, `for`, `while`, `do/while`, `break/continue`, ordinary `switch`, and `static` helper functions. Both `//` and `/* ... */` comments, including UTF-8 comment text, are accepted; block comments must be closed and cannot nest. Simple macros, `typedef`, and enum constants are also covered by the syntax tests. This is a tested subset for the pinned wcc, not a claim of full ISO C conformance. Avoid `goto`, assembly, compiler-specific attributes, and C11/C23 features in generated modules. Standard headers are bundled, but linked libc implementations are not.

The Python launcher already probes Node/WASI/workers. Use the bundled build script rather than creating another compiler runner. Treat `compiler-data.mjs` as executable data; loading its base64 payload into the model context is unnecessary for normal builds.

```sh
python3 "$SKILL/scripts/run.py" build \
  --source /absolute/work/module.c \
  --spec /absolute/work/module.spec.json \
  --out-dir /absolute/work/fresh-result
```

A build inserts prototypes from the spec before the source, compiles with explicit exports and no entrypoint, sets a 16 MiB memory maximum, inspects the actual Wasm ABI, and executes every test in a fresh instance with a three-second deadline. The compiler itself runs in a worker with a 30-second deadline. These resource limits do not make Node WASI a security sandbox.

Successful output: `module.wasm`, `contract.json`, `verification.json`, `module.c`, and `module.spec.json`. Only successful builds publish the fresh output directory. On failure, fix the actual reported source/spec problem and rerun into a new directory. Passing examples does not prove correctness for all inputs.

## Deliver files

Use the host's supported file attachment or download mechanism for the two requested files. If `.wasm` output attachments are unsupported, create a ZIP of the result directory using Python `zipfile` and attach that ZIP. Retain original file names inside it. Include verification status and any material limits. Do not invent download links or claim upload/deployment occurred.

For host execution and upload details, read [references/runtime.md](references/runtime.md). Compiler licensing and pinned provenance: [references/wcc-license.txt](references/wcc-license.txt), [references/provenance.json](references/provenance.json). This skill's ZIP places `SKILL.md` at its root and stays below the 50 MB upload budget.
