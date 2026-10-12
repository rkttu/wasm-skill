# Validation record

This document records checks completed on 2026-10-12 during development for the first `v0.1.0` release. Local execution used Windows ARM64, Python 3.13.7, and Node.js 24.21.0. Linux CI results must be assessed separately from these local checks. Actual Copilot Studio upload and hosted execution remain unverified.

## Native SDK skills

Actual local compilation used the official WASI SDK 34.0 Windows ARM64 compiler through the explicit developer override. Compiler identity: Clang 23.1.0-rc3, LLVM revision `895aa2c896ada719451be2e3673c83da8ddf1141`.

- **20/20 tests passed**, with no failures or skips, including eight real compilation integration cases. Coverage includes all supported scalar types, signed and unsigned 64-bit boundaries, hash and signature agreement, pointer ABI conflicts, unresolved externals, imports, malformed source, incorrect expectations, execution deadlines, and preservation of an existing output directory.
- Both generated native skills passed the official skill-creator `quick_validate.py` validator. The packaged arm64 skill built its six-case numeric helper example with the developer compiler override.
- An independent evaluation generated Celsius-to-Fahrenheit and unsigned greatest-common-divisor functions from a new request. **13/13 examples passed**, covering negative and fractional temperatures, zero arguments, and the unsigned 32-bit maximum. The 476-byte module's contract hash, signatures, and absence of imports were checked.
- Both native ZIPs passed complete CRC checks. Embedded SDK hashes match the pinned official release digests, and packaged scripts match their source. Native Clang ELF machine identifiers are 62 for x86_64 and 183 for AArch64. Execute permission bits remain intact within the original SDK archives.
- The host guard rejected ordinary Linux SDK preparation on Windows. The fetch helper reused verified local caches without network access.

Native Linux x64 and arm64 compilation and first-use extraction were not performed on the local Windows host. Local example contracts correctly record `build.host.platform: "win32"` and `build.compiler_override: true`. The native GitHub Actions workflow defines matching-architecture extraction, the full compiler test suite, and an example build using the bundled compiler.

## Compact Python-entry skill

Actual execution followed **Python 3.13.7 → Node.js 24.21.0 → embedded wcc 0.1.13** on Windows ARM64. The finished skill passed `quick_validate.py`, and its packaged `run.py doctor --self-test` compiled and verified the six-case example.

The Python launcher checks covered runtime versions and capabilities, explicit Node paths, environment and `PATH` discovery, missing or invalid executable diagnostics, UTF-8 forwarding, argument-list invocation, caller path resolution, and timeouts.

- `tests/portable.mjs` passed **10 checks**, including ten executable scalar and void examples, signed and unsigned extremes, internal helper behavior, preserved output, pointer/signedness/variadic prototype conflicts, unresolved functions, incorrect expectations, runtime timeout, excessive initial memory, and memory-limit addition or tightening. Rejected builds published no output and left no temporary build directories.
- An independent evaluation used the packaged Python entrypoint to generate Celsius conversion and uint32 GCD functions. **14/14 specified examples and 2,000 independently generated inputs passed**. The 146-byte module had a matching SHA-256 digest, `(f64) -> f64` and `(i32, i32) -> i32` signatures, no imports or start section, and a 16 MiB memory maximum.
- The documented Python authoring example completed environment diagnosis, UTF-8 source/specification creation, compilation, and five-file ZIP delivery. Normal unsigned addition and `UINT32_MAX + 1` wraparound tests passed. ZIP entries and CRCs were checked.
- A further independent evaluation created int32 wraparound addition with UTF-8 comments using Python file-writing APIs and a subprocess argument list with `shell=False`. **The first build succeeded without retries**, and **51 normal and boundary examples passed** both the bundled verifier and independent BigInt checks. Source bytes, module hash, ZIP CRC, and the five expected filenames were checked.

Packaging enforces `SKILL.md` at the ZIP root, only `.md`, `.txt`, `.json`, `.py`, and `.mjs` resources, at most 350 files, a maximum depth of three, less than 25 MB per file, and instructions below 20,000 characters. Compressed and expanded totals are below 50,000,000 bytes. Complete ZIP CRC and compiler integrity checks passed. English documentation and license updates alter the final package digest and size; release checksums identify the published assets.

### Compiler provenance

The upstream wcc compiler is **350,188 bytes**, SHA-256 `b8d5751d6b538b8bfd97b7eaf111a8587b10e3c4201f6ba0941a5e8df0f34725`. Recompiling its 27 compiler sources from upstream revision `9eea241c1331d54730b9173cfb11c4dea7c893a4` with the deployed compiler and the same output basename reproduced this exact binary hash.

The compact skill includes compiler provenance and the upstream MIT license. It ships neither libc archives nor a native SDK. Compiler execution and generated-module verification use worker deadlines. Node WASI is not a security sandbox.

### C syntax profile

The measured syntax suite contained **45 feature cases: 34 accepted and 11 rejected**, with **58 compiled runtime examples** passing. The Node test runner reported **46/46** when counting the parent suite.

Coverage includes both comment forms, UTF-8 comments, CRLF, scalar declarations and operators, control flow and preprocessing, selected internal arrays/structs/pointers/recursion, restricted goto and switch layouts, and separate public ABI and missing-library rejection cases. `_Generic` compiled; `_Static_assert` was rejected. These probes do not establish complete C99 or C11 conformance. The [syntax reference](portable-template/references/c-syntax.md) records practical guidance from the probes.

The Python authoring and diagnostic reuse guidance aims to reduce shell quoting and retry steps. Copilot Studio latency improvements have not been measured.

## Remaining limits

Local checks do not establish compatibility with a specific Copilot Studio tenant, the availability of Python subprocesses/Node/WASI in that tenant, or native Linux execution. The compact resources are shared across x64 and arm64, provided the required runtimes are available. GitHub Actions defines both Linux architecture checks for the native and compact skills; passing runs provide separate evidence for those hosts.

Tests establish behavior for their executed inputs, not universal correctness. Extreme floating-point values, integer overflow semantics, and other request-specific boundaries still require deliberate source design and relevant tests. The [runtime reference](portable-template/references/runtime.md) documents product-specific upload/runtime distinctions and links to official guidance.

## Reproduce

```sh
node tools/fetch-sdk.mjs
node tools/package.mjs
python3 tools/package-portable.py --fetch

node --test tests/portable.mjs
node --test tests/wcc-syntax.mjs
python3 tests/authoring.py
python3 skills/c-wasm-portable-wcc/scripts/run.py doctor --self-test
python3 tools/check-packages.py
```

For a full native suite on a matching Linux host:

```sh
node skills/c-wasm-linux-arm64/scripts/prepare.mjs
WASM_SKILL_TEST_CLANG=/returned/cache/path/bin/clang node --test tests/test.mjs
```

The native skills require no Python during normal use. Python is needed for compact skill execution and development packaging/inspection helpers.
