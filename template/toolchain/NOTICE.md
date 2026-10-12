# Bundled toolchain

This package includes the unmodified `wasi-sdk-34.0-{{SDK_ARCH}}-linux.tar.gz` release archive from [WebAssembly/wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34), stored as `wasi-sdk.tar.gz`.

Archive SHA-256: `{{SHA256}}`.

The release archive is preserved unmodified. Accompanying upstream license texts are supplied in `licenses/`, fetched from the source revisions pinned by wasi-sdk-34 and recorded in `source-revisions.json`. These cover LLVM, the SDK, WASI libc, and musl. LLVM's license text also identifies separately licensed components. The compiler runs natively on Linux {{ARCH}} and emits architecture-independent wasm32 modules.
