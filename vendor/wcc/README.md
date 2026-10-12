# Pinned upstream wcc assets

`wccfiles.zip` is the unmodified asset downloaded from
https://tyfkda.github.io/xcc/wccfiles.zip. It is retained here so a future
portable skill build does not depend on that mutable deployment URL.

The archive is 166,292 bytes, SHA-256
`6e8f87c818a815bd534f8e16e1c537dbb2fff7d48ff8b18d1dd9f402c709d0d7`.
The contained compiler is 350,188 bytes, SHA-256
`b8d5751d6b538b8bfd97b7eaf111a8587b10e3c4201f6ba0941a5e8df0f34725`.

The source revision is `9eea241c1331d54730b9173cfb11c4dea7c893a4` in
[tyfkda/xcc](https://github.com/tyfkda/xcc). Rebuilding all 27 compiler source
files with the deployed compiler and the same output basename reproduced
the exact compiler bytes during local validation. The full provenance and
expected hashes are in `wcc-toolchain.json` at the repository root.

The compiler and headers are MIT-licensed; see `LICENSE.txt`. Portable
packaging uses the compiler and headers, and excludes the libc archives.
The skill carries its own copy of the upstream MIT notice.
