# Spec and contract, version 0.1.0

The model writes a C module and a JSON spec. The script generates `contract.json` from the spec and the compiled binary; the model must not fabricate the final hashes or signatures.

## Input spec

```json
{
  "name": "adder",
  "description": "Add two integers whose sum fits int32_t.",
  "exports": [
    {
      "name": "add",
      "description": "Return a + b.",
      "params": [{"name": "a", "type": "int32_t"}, {"name": "b", "type": "int32_t"}],
      "result": "int32_t"
    }
  ],
  "tests": [{"export": "add", "args": [2, 3], "expected": 5}]
}
```

Export and parameter names must be C identifiers. Public C types are restricted to this mapping:

| C type | Wasm type | JSON argument / result |
| --- | --- | --- |
| `int32_t` | `i32` | Integer number, signed 32-bit range |
| `uint32_t` | `i32` | Integer number, unsigned 32-bit range |
| `int64_t` | `i64` | Decimal string, signed 64-bit range |
| `uint64_t` | `i64` | Decimal string, unsigned 64-bit range |
| `float` | `f32` | Finite number |
| `double` | `f64` | Finite number |
| `void` (return only) | No results | Omit `expected` |

Each export requires at least one test. The `args` array must match the parameter list. Float tests accept an optional finite `tolerance` between 0 and 0.01; comparison uses `abs(actual - expected) <= tolerance * max(1, abs(expected))`. Defaults: 1e-6 for float, 1e-12 for double. Generated contracts preserve C signedness and parameter labels from the spec. These cannot be reconstructed from core Wasm types alone.

The compiler force-includes generated prototypes before the C source so public pointer, struct, variadic, and incompatible type definitions fail compilation. Declare exported functions with external linkage. Only declared public functions are exported; helper functions may remain internal. Source is copied into a temporary build directory, so project-local quoted includes are outside this single-file MVP. Built-in compiler headers such as `<stdint.h>` are available.

## Generated artifacts

- `module.wasm`: A valid wasm32 core module with no imports or start section, numeric scalar function exports, and at most 16 MiB of linear memory.
- `contract.json`: Module file name, SHA-256, bytes, target and ABI (`scalar-v1`), actual export signatures, C labels/descriptions from the spec, memory limits, compiler identity, source hash, and validation results.
- `module.c`: Exact generated source for reproducibility.
- `module.spec.json`: The checked spec used to build the module.
- `verification.json`: Actual test results with 64-bit integer values represented as decimal strings. Each case runs in a fresh instance with a three-second deadline. A void test checks successful execution without a trap, rather than an output value.

All five files are published together in a fresh result directory only after compilation and verification succeed. Re-run the build into a different directory to revise a module. The scripts do not call an AI service: the invoking model performs the request-to-C step, and these scripts perform compilation and validation.

Consumers verify `contract.module.sha256` against `module.wasm`, convert i64 arguments to JavaScript `BigInt`, and instantiate with an empty import object. For unsigned returns use `value >>> 0` for uint32_t and `BigInt.asUintN(64, value)` for uint64_t. A module can have internal mutable state; passing the listed examples does not establish universal correctness or purity. Use execution time/memory limits when invoking generated code in your own service.

Sources: [WebAssembly C ABI](https://github.com/WebAssembly/tool-conventions/blob/main/BasicCABI.md), [core binary sections](https://webassembly.github.io/spec/core/binary/modules.html), [WASI SDK](https://github.com/WebAssembly/wasi-sdk).
