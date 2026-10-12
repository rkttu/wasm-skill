# C to Wasm skills

Agent Skills that turn a user's request into C functions, compile them to WebAssembly, and deliver verified interface metadata. The model writes the C source and JSON specification; the bundled scripts compile the source, inspect the actual binary, and run the specified tests. The scripts do not call an AI API.

## Download

The first release is `v0.1.0`. Download the skill ZIPs and their SHA-256 checksums from [GitHub Releases](https://github.com/rkttu/wasm-skill/releases).

| Release asset | Runtime requirements | Approximate ZIP size |
| --- | --- | --- |
| `c-wasm-linux-x64.zip` | glibc Linux x86_64, Node.js 22+, `tar` | 184 MiB |
| `c-wasm-linux-arm64.zip` | glibc Linux AArch64, Node.js 22+, `tar` | 184 MiB |
| `c-wasm-portable-wcc.zip` | Python 3.10+, Node.js 22+ with WASI and workers | 200 KiB |

All three skills produce portable `wasm32` modules. The native packages include the complete official WASI SDK 34.0 archive for their host architecture. First use verifies its SHA-256 digest and extracts it to a cache; normal builds need no network access or system compiler installation. Alpine/musl hosts have not been validated.

The compact package uses one Wasm-hosted **wcc 0.1.13** compiler on both x64 and arm64. Python invokes Node.js, and Node's built-in WASI implementation runs the embedded compiler. No runtime download, npm package, pip package, or native SDK is required. Both compressed and expanded sizes must remain below the conservative decimal 50,000,000-byte limit enforced by the packaging script.

## Use the compact skill

Upload `c-wasm-portable-wcc.zip` to a compatible Agent Skills host, or extract it into a named skill directory. Its `SKILL.md` is at the ZIP root, so local installation needs an explicit destination:

```sh
mkdir -p .agents/skills/c-wasm-portable-wcc
unzip c-wasm-portable-wcc.zip -d .agents/skills/c-wasm-portable-wcc
SKILL="$PWD/.agents/skills/c-wasm-portable-wcc"

python3 "$SKILL/scripts/run.py" doctor --self-test
python3 "$SKILL/scripts/run.py" build \
  --source "$SKILL/examples/module.c.txt" \
  --spec "$SKILL/examples/module.spec.json" \
  --out-dir "$PWD/numeric-result"
```

If Node.js is not on `PATH`, add `--node /absolute/path/to/node` to either command or set `WASM_SKILL_NODE`. From a Python execution tool, invoke `run.py` with `subprocess.run()` and an argument list. The [authoring example](portable-template/references/authoring.md) covers file creation, build, and ZIP delivery without shell heredocs.

A short request for an agent with this skill and suitable instructions is:

```text
Create Celsius-to-Fahrenheit (double) and greatest-common-divisor
(uint32_t, gcd(0,0)=0) functions, then provide the compiled and tested
Wasm, contract, source, and verification results in a ZIP.
```

The host must allow Python subprocesses, Node.js WASI and workers, and writes to an output directory. **Actual Copilot Studio upload and hosted execution have not been validated.** ZIP upload support alone does not establish runtime availability; `doctor --self-test` checks the execution environment. Product-specific constraints and official documentation are collected in the [runtime reference](portable-template/references/runtime.md). The host must also provide a file attachment or download mechanism.

wcc supports a smaller C subset than Clang. The measured [C syntax profile](portable-template/references/c-syntax.md) records accepted and rejected constructs, including comments, control flow, preprocessing, and internal data structures. The public scalar ABI is a separate restriction. Library headers are bundled, but libc implementations are not linked. Successful environment diagnostics can be reused within the same unchanged runtime. Reduced Copilot Studio processing time has not been measured.

## Use a native SDK skill

Select the ZIP matching the Linux host architecture. Native ZIPs contain their named outer directory:

```sh
mkdir -p .agents/skills
unzip c-wasm-linux-x64.zip -d .agents/skills
SKILL="$PWD/.agents/skills/c-wasm-linux-x64"

node "$SKILL/scripts/build.mjs" \
  --source "$SKILL/examples/module.c" \
  --spec "$SKILL/examples/module.spec.json" \
  --out-dir "$PWD/numeric-result"
```

Use `c-wasm-linux-arm64` on AArch64. In a skill-aware agent, request the named skill and describe the desired functions. The agent writes the source and specification, runs the real build script, and returns the resulting files.

## Outputs and scope

Each successful build publishes a fresh directory containing:

- `module.wasm`: the compiled module.
- `contract.json`: actual function signatures, module and source hashes, memory limits, compiler identity, and validation summary.
- `verification.json`: test inputs, expected values, and observed results.
- `module.c` and `module.spec.json`: reproducible source and normalized specification.

Existing output directories are preserved. Failed compilation, ABI checks, or runtime tests leave no published result directory. See the [contract reference](template/references/contract.md) for the specification and output format.

Public parameters and return values support `int32_t`, `uint32_t`, `int64_t`, `uint64_t`, `float`, and `double`; `void` returns are also allowed. JSON represents 64-bit integer values as decimal strings. Public pointer, string, array, struct, and variadic interfaces are outside this MVP's scope. Modules have no imports or start section and a linear-memory maximum of 16 MiB.

The scripts generate a C prototype header from the specification and compare actual Wasm exports and types against it. Each test runs in a fresh Wasm instance with a three-second deadline. Tests do not prove correctness for all inputs or function purity. Node WASI is not a security sandbox. Here, a contract means Wasm interface metadata; no blockchain-specific contract or ABI is implemented.

## Build from source

Common implementation is in `src/`, native skill resources in `template/`, and compact skill resources in `portable-template/`. Generated `skills/`, `dist/`, embedded compiler data, download caches, and local test artifacts are excluded from version control. Release ZIPs include their required compiler assets.

Packaging requires Node.js 22+ and Python 3.10+. Native SDK packaging downloads upstream release archives and verifies their pinned sizes and SHA-256 digests from `toolchains.json`. Compact packaging verifies and uses the unmodified asset in `vendor/wcc/wccfiles.zip`, pinned by `wcc-toolchain.json`, without network access. The optional `--fetch` flag supplies a development fallback only when that vendored asset and the local cache are absent:

```sh
node tools/fetch-sdk.mjs
node tools/package.mjs
python3 tools/package-portable.py --fetch
```

The installed skills do not download assets during normal builds. To prepare only the compact compiler data for source-level tests, use `python3 tools/package-portable.py --fetch --data-only`.

Run the relevant checks after packaging:

```sh
node --test tests/test.mjs
node --test tests/portable.mjs
node --test tests/wcc-syntax.mjs
python3 tests/authoring.py
python3 tools/check-packages.py
```

Native compiler integration cases require the compiler path returned by the matching packaged skill:

```sh
node skills/c-wasm-linux-x64/scripts/prepare.mjs
WASM_SKILL_TEST_CLANG=/returned/path/bin/clang node --test tests/test.mjs
```

Without `WASM_SKILL_TEST_CLANG`, the native test suite skips compiler integration cases. GitHub Actions defines native and compact checks on Linux x64 and arm64 and a tagged release pipeline that builds the three ZIP assets and checksums. Recorded local results and remaining validation limits are in [VALIDATION.md](VALIDATION.md).

## License

Original project code and documentation are licensed under [Apache License 2.0](LICENSE). Every skill ZIP includes `LICENSE.txt` and `NOTICE.txt`. Bundled third-party components retain their own licenses: wcc and its headers use MIT; the WASI SDK contains LLVM and other components with their accompanying notices. See [NOTICE](NOTICE), the packaged toolchain notices, and `portable-template/references/wcc-license.txt`. The project license does not replace third-party terms.
