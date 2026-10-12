---
name: c-wasm-linux-{{ARCH}}
description: "Generate C functions from user requests, compile portable WebAssembly, and deliver a verified contract.json using the bundled compiler on Linux {{ARCH}} hosts. Use for small callable Wasm modules with numeric scalar inputs and outputs."
---

# C to Wasm PoC — Linux {{ARCH}}

Turn the user's requested behavior into C source, compile it, verify its public ABI and examples, and deliver `module.wasm` with `contract.json`. The x64/arm64 label selects the compiler host; both packages produce the same portable wasm32 ABI.

Requires a glibc-based Linux {{ARCH}} host, Node.js 22 or newer, and `tar`. The pinned WASI SDK is bundled in `toolchain/wasi-sdk.tar.gz`; normal builds need no network, API key, or system compiler installation. Scripts unpack it into the system temporary directory and reuse the cache. Set `WASM_SKILL_CACHE` to a writable directory if necessary. Run `node <skill-dir>/scripts/prepare.mjs` to check prerequisites or prepare the compiler.

## Generate and build

1. Translate the requested behavior into a small C11 module and a spec JSON. Read [references/contract.md](references/contract.md) for the exact spec format. Use [examples/module.c](examples/module.c) and [examples/module.spec.json](examples/module.spec.json) when a concrete starting point helps.
2. Export only numeric scalar functions: `int32_t`, `uint32_t`, `int64_t`, `uint64_t`, `float`, or `double`; `void` is also allowed as a return type. Include `<stdint.h>`. Keep pointer, string, array, struct, variadic, and callback types out of the public API. Internal arrays and pointers are allowed. Avoid libc, OS calls, and external libraries. If the request needs a richer public API, explain this MVP boundary before adapting the request; do not silently discard required behavior.
3. Write at least one meaningful input/output test per exported function in the spec. Include boundary cases relevant to the request. Encode 64-bit integers as decimal JSON strings. Specify a float tolerance when the request needs a particular precision. The spec records user-facing names and descriptions; the build script derives actual Wasm signatures and hashes.
4. Save the source and spec in the user's working directory, and select a new output directory. Use absolute paths when invoking the bundled build script:

   ```sh
   node <skill-dir>/scripts/build.mjs --source <work>/module.c --spec <work>/module.spec.json --out-dir <work>/result
   ```

   The script compiles with the bundled Clang, checks the exported C declarations and Wasm signatures, rejects imports and a start section, and executes the spec tests with time limits. It publishes the output directory only after success. It never overwrites an existing result directory. Do not use the developer `--clang` override during ordinary skill use.
5. If compilation or verification fails, use the diagnostic to correct the source/spec and retry in a new output directory. Stop after three failed repair attempts and report the actual error and current files. Do not present failed or stale artifacts as a completed result.
6. Link or attach the actual `module.wasm` and `contract.json` using the host's artifact delivery facility. Include `verification.json` and the source when useful, and report the tested examples briefly. If the host cannot deliver files, provide their exact local paths and state that limitation. Do not invent download URLs or output binary data as prose.

## Verified scope

The contract verifies the module hash, public numeric signatures, absence of imports, and the supplied test cases. It does not prove purity, correctness for every input, termination for every input, or freedom from C undefined behavior. Describe this as a standalone numeric Wasm module; the PoC does not produce a blockchain-specific smart-contract ABI.
