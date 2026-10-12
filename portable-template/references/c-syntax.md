# Verified C profile for portable-wcc

This profile applies to the embedded **wcc 0.1.13**, source revision `9eea241c1331d54730b9173cfb11c4dea7c893a4`, compiler SHA-256 `b8d5751d6b538b8bfd97b7eaf111a8587b10e3c4201f6ba0941a5e8df0f34725`. It is a practical authoring profile based on the actual bundled compiler and build wrapper, not a complete ISO C grammar or a promise that every combination of supported features works.

The compiler declares `__STDC_VERSION__` as `199901L`; it is C99-oriented with selected newer/GNU features. Use the default subset below to reduce retries. Compile and test the result even when it uses this subset.

## Default syntax: compiled and executed successfully

| Area | Use |
| --- | --- |
| Source | A single UTF-8 file without a BOM, ordinary LF or CRLF newlines; ASCII C identifiers |
| Comments | `// line comment` and `/* block comment */`, multiline blocks, Korean/UTF-8 comment text |
| Public function types | `int32_t`, `uint32_t`, `int64_t`, `uint64_t`, `float`, `double`; `void` return |
| Internal declarations | Scalar local variables, initializers, `const`, simple casts, `sizeof`, `typedef`, enum constants |
| Operators | `+ - * / %`, comparisons, `&& \|\| !` with short-circuit behavior, bitwise operators, shifts, assignment and increment/decrement, `?:` |
| Conditions | `if/else`, nested conditions, ordinary `switch/case/default` at the switch-body level |
| Loops | `while`, `do/while`, `for` including a variable declaration in the initializer; `break`, `continue` |
| Functions | Public functions with exact spec-compatible prototypes; `static` helper functions |
| Preprocessor | Bundled `#include`, object/function-like `#define`, `#if`, `#ifdef`, `#undef`, include guards |

Comments must be properly closed. C block comments cannot nest. Write preprocessor directives on their own lines; text like `#include` in a C comment does not become a directive. Ordinary comments do not require stripping before compiling. A shell heredoc delimiter or quoting error happens while generating the file, before the C compiler handles its comments.

Start numeric modules with `#include <stdint.h>`. Use explicit-width types rather than assuming the host's `long` or pointer size. The Wasm compiler uses 32-bit int/long/pointers and 64-bit long long regardless of the host's architecture. Public types in the JSON spec must use the exact names from the contract reference.

## Compiler syntax versus this skill's interface

Local fixed-size arrays, local structs, internal pointers, bounded recursion, and a simple `_Generic` expression passed direct probes. These are not necessary for typical arithmetic requests; prefer simpler code where it serves the request. This does **not** mean arrays, structs or pointers are allowed as public function parameters/results. The skill's scalar-v1 schema and generated prototypes independently prohibit those public APIs, plus variadic public functions. A cast or an i32 Wasm signature does not turn a pointer API into a scalar API.

Use the bundled headers as needed. `<stdint.h>`, `<stddef.h>` and `<stdbool.h>` were included in the syntax probes. Header declarations alone do not provide runtime implementations. The builder uses `-nostdlib`; direct calls to `printf`, `malloc`/`free` or `sin` fail with unresolved symbols in the tested package. Implement small numeric algorithms without external calls or report the missing dependency. All external imports are rejected by the final Wasm inspection.

## Features to avoid in this profile

- `_Static_assert` was rejected by the pinned compiler. Avoid relying on untested C11/C23 features, atomics, threads or compiler intrinsics; the accepted `_Generic` probe is not evidence of full C11 support.
- `goto` has restricted escape/forward support. Use structured loops/conditions instead.
- Keep `case`/`default` labels directly in the switch body. Labels nested inside another branch are rejected by the Wasm backend.
- Avoid inline/file-scope assembly and compiler-specific attributes. The wcc assembly mechanism is specialized and is not a general GCC/Clang assembly interface.
- Avoid project-local includes: the MVP copies one source file into its build directory, not the user's project tree.
- Do not ignore warnings. This wrapper treats compiler stderr, including warnings, as a failed build. Fix the actual diagnostic.

## Arithmetic semantics to define before implementation

Syntax acceptance is separate from defined behavior and numerical correctness.

- Signed integer overflow is not a C wrapping contract. For required wrapping arithmetic, use unsigned intermediate arithmetic and an explicit, range-safe conversion policy. Merely adding int32_t operands does not establish that policy.
- Integer division/remainder by zero and `INT32_MIN / -1` require explicit handling if those inputs belong to the requested domain. The generated Wasm can trap; the compiler accepting `/` or `%` does not establish an error policy. Return 0, report an error, or constrain inputs according to the user's requested behavior, and test those choices.
- Restrict shift counts to the type width and avoid undefined signed shifts. Use unsigned operands for bit manipulation.
- Floating-point expressions can overflow or lose precision. For Celsius conversion prefer `celsius * (9.0 / 5.0) + 32.0` over multiplying by 9 before dividing by 5, to reduce intermediate overflow. Define the input domain and handling of unrepresentable final results. Spec tests require finite values.

The repository's `tests/wcc-syntax.mjs` records the feature probes and actual expected outputs. Compiler syntax probes are separate from public ABI rejection and missing-library probes. They currently run on Windows ARM64 using the same embedded Wasm compiler; native Linux execution is a separate runtime check.

Pinned upstream implementation references:

- [Comments in the lexer](https://github.com/tyfkda/xcc/blob/9eea241c1331d54730b9173cfb11c4dea7c893a4/src/cc/frontend/lexer.c#L334)
- [Preprocessor block comments](https://github.com/tyfkda/xcc/blob/9eea241c1331d54730b9173cfb11c4dea7c893a4/src/cpp/preprocessor.c#L96)
- [C version and Wasm data model](https://github.com/tyfkda/xcc/blob/9eea241c1331d54730b9173cfb11c4dea7c893a4/src/wcc/wcc.c#L707)
- [Wasm control-flow limitations](https://github.com/tyfkda/xcc/blob/9eea241c1331d54730b9173cfb11c4dea7c893a4/src/wcc/traverse.c#L551)
