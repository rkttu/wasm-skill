import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile, writeFile, mkdir, mkdtemp, lstat, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from '../src/portable/build.mjs';
import {PROVENANCE} from '../src/portable/compiler.mjs';

// Empirical compiler/skill checks, not a C standard conformance suite.
// Run: node --test tests/wcc-syntax.mjs
// Every run keeps its exact UTF-8 inputs, successful modules, and diagnostics.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputParent = path.join(projectRoot, '.test-output');
await mkdir(outputParent, {recursive: true});
const outputRoot = await mkdtemp(path.join(outputParent, 'wcc-syntax-'));
const fixture = (id, feature, source, values, options = {}) => ({
  id, feature, source: `#include <stdint.h>\n${source}\n`,
  params: ['int32_t'], result: 'int32_t', values,
  expected: 'accepted', category: 'compiler-syntax', ...options,
});
const fixtures = [
  fixture('line-comment', 'ASCII // line comments', '// line comment\nint32_t run(int32_t x) { return x + 1; // trailing comment\n}', [[4, 5], [-3, -2]]),
  fixture('block-comment', 'ASCII /* multiline */ comments', '/* first line\n   second line */\nint32_t run(int32_t x) { return x /* between tokens */ + 1; }', [[4, 5]]),
  fixture('korean-line-comment', 'UTF-8 Korean // comments', '// \ud55c\uae00 \uc8fc\uc11d: \uc785\ub825\uac12\uc5d0 \uc77c\uc744 \ub354\ud569\ub2c8\ub2e4.\nint32_t run(int32_t x) { return x + 1; // \uacb0\uacfc \ubc18\ud658\n}', [[4, 5]]),
  fixture('korean-block-comment', 'UTF-8 Korean /* multiline */ comments', '/* \ud55c\uae00 \uc5ec\ub7ec \uc904 \uc8fc\uc11d\n   \uc785\ub825\uac12\uc5d0 \uc77c\uc744 \ub354\ud569\ub2c8\ub2e4. */\nint32_t run(int32_t x) { return x /* \uc911\uac04 \uc8fc\uc11d */ + 1; }', [[4, 5]]),
  fixture('crlf-comments', 'CRLF with both Korean comment forms', '// \ud55c\uae00 \ud55c \uc904 \uc8fc\uc11d\n/* \ud55c\uae00 \uc5ec\ub7ec \uc904 \uc8fc\uc11d\n   \ub2e4\uc74c \uc904\ub3c4 \uc8fc\uc11d\uc785\ub2c8\ub2e4. */\nint32_t run(int32_t x) { return x + 1; // \uacb0\uacfc \ubc18\ud658\n}', [[4, 5]], {line_endings: 'CRLF'}),
  fixture('basic-types', 'char/short/int/long/long long, signed/unsigned, _Bool locals', 'int32_t run(int32_t x) { signed char a = -2; unsigned char b = 3; short c = 4; unsigned short d = 5; int e = 6; unsigned int f = 7; long g = 8L; unsigned long h = 9UL; long long i = 10LL; unsigned long long j = 11ULL; _Bool k = x != 0; return a + b + c + d + e + f + g + h + i + j + k; }', [[0, 61], [2, 62]]),
  fixture('sizeof', 'sizeof(type), sizeof expression, and unevaluated operand', 'int32_t run(int32_t x) { int32_t y = x; return sizeof(int32_t) + sizeof(double) + sizeof y + sizeof(y++) + y; }', [[7, 27]]),
  fixture('casts', 'explicit casts between integer and floating types', 'int32_t run(int32_t x) { double y = (double)x / 2.0; return (int32_t)y + (unsigned char)257; }', [[7, 4], [-7, -2]]),
  fixture('const-local', 'const scalar locals', 'int32_t run(int32_t x) { const int32_t offset = 3; const double scale = 2.0; return (int32_t)(x * scale) + offset; }', [[4, 11]]),
  fixture('if-else', 'if/else branching', 'int32_t run(int32_t x) { if (x < 0) return -x; else if (x == 0) return 10; else return x + 1; }', [[-3, 3], [0, 10], [3, 4]]),
  fixture('ternary', 'conditional ?: expression', 'int32_t run(int32_t x) { return x < 0 ? -x : x + 1; }', [[-3, 3], [3, 4]]),
  fixture('while', 'while loop', 'int32_t run(int32_t x) { int32_t total = 0; while (x > 0) { total += x; --x; } return total; }', [[4, 10], [0, 0]]),
  fixture('do-while', 'do/while loop', 'int32_t run(int32_t x) { int32_t total = 0; do { total += 2; --x; } while (x > 0); return total; }', [[3, 6], [0, 2]]),
  fixture('for-c99', 'for loop with C99-style declaration', 'int32_t run(int32_t x) { int32_t total = 0; for (int32_t i = 0; i < x; ++i) total += i; return total; }', [[5, 10], [0, 0]]),
  fixture('break-continue', 'loop break and continue', 'int32_t run(int32_t x) { int32_t total = 0; for (int32_t i = 0; i < x; ++i) { if (i == 2) continue; if (i == 5) break; total += i; } return total; }', [[8, 8], [2, 1]]),
  fixture('switch', 'switch/case/default, fallthrough, and break', 'int32_t run(int32_t x) { int32_t y = 0; switch (x) { case 0: return 10; case 1: y = 2; case 2: y += 3; break; default: y = 20; } return y; }', [[0, 10], [1, 5], [2, 3], [3, 20]]),
  fixture('static-helper', 'static helper function under scalar export', 'static int32_t helper(int32_t x) { return x * x; }\nint32_t run(int32_t x) { return helper(x) + 1; }', [[4, 17], [-3, 10]]),
  fixture('typedef-enum', 'typedef and enum constants', 'typedef int32_t Count;\nenum Mode { FIRST = 2, SECOND, THIRD = 7 };\nint32_t run(int32_t x) { Count y = x; enum Mode mode = SECOND; return y + mode + THIRD; }', [[4, 14]]),
  fixture('integer-arithmetic', 'integer + - * / %, unary minus, and compound assignment', 'int32_t run(int32_t x) { int32_t y = x; y += 3; y *= 2; y -= 4; y /= 2; y %= 7; return -y + x / 3 + x % 3; }', [[11, 0], [0, -1]]),
  fixture('floating-arithmetic', 'double + - * / arithmetic', 'double run(double x) { double y = (x + 0.5) * 2.0 - 1.0; return y / 4.0; }', [[3.5, 1.75], [-1.5, -0.75]], {params: ['double'], result: 'double'}),
  fixture('floating-comparisons', 'double < <= > >= == != comparisons', 'int32_t run(double x) { return (x < 2.0) + 2 * (x <= 2.0) + 4 * (x > 2.0) + 8 * (x >= 2.0) + 16 * (x == 2.0) + 32 * (x != 2.0); }', [[1.5, 35], [2, 26], [2.5, 44]], {params: ['double']}),
  fixture('float-arithmetic', 'float literals and arithmetic', 'float run(float x) { return (x + 0.5f) * 2.0f - 1.0f; }', [[3.5, 7], [-1.5, -3]], {params: ['float'], result: 'float'}),
  fixture('bitwise', 'integer bitwise &, |, ^, ~, <<, >>', 'uint32_t run(uint32_t x) { return (((x << 2) | 3U) ^ 5U) + ((x >> 1) & 7U) + ((~x) & 15U); }', [[6, 42], [0, 21]], {params: ['uint32_t'], result: 'uint32_t'}),
  fixture('logical-short-circuit', '&&, ||, !, comparisons, and skipped side effects', 'int32_t run(int32_t x) { int32_t hits = 0; int32_t a = 0 && ++hits; int32_t b = 1 || ++hits; int32_t c = x && ++hits; return hits * 10 + a + b + c + !x; }', [[0, 2], [5, 12]]),
  fixture('define-object', '#define object-like macro', '#define OFFSET 7\nint32_t run(int32_t x) { return x + OFFSET; }', [[4, 11]]),
  fixture('define-function', '#define function-like macro', '#define PLUS(a,b) ((a) + (b))\nint32_t run(int32_t x) { return PLUS(x, 7); }', [[4, 11]]),
  fixture('preprocessor-conditionals', '#if/#elif/#else/#endif, defined, #ifdef/#ifndef, #undef', '#define VALUE 2\n#if VALUE == 1\n#define OFFSET 100\n#elif VALUE == 2\n#define OFFSET 7\n#else\n#define OFFSET 200\n#endif\n#ifdef VALUE\n#undef VALUE\n#endif\n#ifndef VALUE\n#define EXTRA 3\n#endif\n#if !defined(VALUE)\nint32_t run(int32_t x) { return x + OFFSET + EXTRA; }\n#endif', [[4, 14]]),
  fixture('bundled-includes', '#include <stdint.h>, <stddef.h>, <stdbool.h> definitions', '#include <stddef.h>\n#include <stdbool.h>\nint32_t run(int32_t x) { size_t n = 3; bool ok = x > 0; return (int32_t)n + (ok ? 1 : 0); }', [[4, 4], [-1, 3]]),
  fixture('local-array', 'internal fixed-size array with indexing', 'int32_t run(int32_t x) { int32_t values[3] = {2, 4, 6}; values[1] += x; return values[0] + values[1] + values[2]; }', [[4, 16]], {category: 'advanced-internal-syntax'}),
  fixture('local-struct', 'internal struct, initializer, and member access', 'struct Pair { int32_t left; int32_t right; };\nint32_t run(int32_t x) { struct Pair p = {x, 3}; p.left += p.right; return p.left; }', [[4, 7]], {category: 'advanced-internal-syntax'}),
  fixture('local-pointer', 'internal address-of, pointer, dereference, and pointer helper', 'static int32_t read_value(const int32_t *p) { return *p; }\nint32_t run(int32_t x) { int32_t y = x; int32_t *p = &y; *p += 3; return read_value(p); }', [[4, 7]], {category: 'advanced-internal-syntax'}),
  fixture('static-assert', 'C11 _Static_assert syntax', '_Static_assert(sizeof(int32_t) == 4, "int32 size");\nint32_t run(int32_t x) { return x + 1; }', [[4, 5]], {category: 'advanced-internal-syntax', expected: 'rejected', diagnostic: /unexpected token/}),
  fixture('generic', 'C11 _Generic syntax', 'int32_t run(int32_t x) { return _Generic(x, int32_t: 7, default: 9); }', [[4, 7]], {category: 'advanced-internal-syntax'}),
  fixture('recursion', 'bounded internal recursion', 'static int32_t factorial(int32_t n) { return n <= 1 ? 1 : n * factorial(n - 1); }\nint32_t run(int32_t x) { return factorial(x); }', [[5, 120], [0, 1]], {category: 'advanced-internal-syntax'}),
  fixture('forward-goto', 'forward escape goto', 'int32_t run(int32_t x) { if (x == 0) goto done; x += 3; done: return x; }', [[0, 0], [4, 7]], {category: 'advanced-internal-syntax'}),
  fixture('backward-goto', 'backward goto rejected by Wasm code generation', 'int32_t run(int32_t x) { again: x -= 1; if (x > 0) goto again; return x; }', [[4, 0]], {category: 'advanced-internal-syntax', expected: 'rejected', diagnostic: /only escape goto supported/}),
  fixture('deeper-goto', 'goto into deeper block rejected by Wasm code generation', 'int32_t run(int32_t x) { goto inside; { inside: x += 1; } return x; }', [[4, 5]], {category: 'advanced-internal-syntax', expected: 'rejected', diagnostic: /only escape goto supported/}),
  fixture('nested-case', 'case label nested inside branch rejected', 'int32_t run(int32_t x) { switch (x) { if (x >= 0) { case 1: return 7; } default: return 9; } }', [[1, 7]], {category: 'advanced-internal-syntax', expected: 'rejected', diagnostic: /case\/default inside branch not supported/}),
  fixture('public-pointer-spec', 'pointer parameter forbidden by scalar spec', 'int32_t run(int32_t *x) { return *x; }', [[4, 4]], {params: ['int32_t*'], expected: 'rejected', category: 'public-abi', diagnostic: /Unsupported parameter type/}),
  fixture('public-struct-spec', 'struct result forbidden by scalar spec', 'struct Pair { int32_t x; };\nstruct Pair run(int32_t x) { struct Pair p = {x}; return p; }', [[4, 4]], {result: 'struct Pair', expected: 'rejected', category: 'public-abi', diagnostic: /Unsupported result type/}),
  fixture('public-pointer-mismatch', 'pointer source signature conflicts with generated scalar declaration', 'int32_t run(int32_t *x) { return *x; }', [[4, 4]], {expected: 'rejected', category: 'generated-contract', diagnostic: /Conflicting|conflict|diagnostic/i}),
  fixture('public-variadic-mismatch', 'variadic source signature conflicts with generated fixed declaration', 'int32_t run(int32_t x, ...) { return x; }', [[4, 4]], {expected: 'rejected', category: 'generated-contract', diagnostic: /Conflicting|conflict|diagnostic/i}),
  fixture('libc-printf', '<stdio.h> declaration exists; printf is not linked', '#include <stdio.h>\nint32_t run(int32_t x) { printf("value %d\\n", x); return x; }', [[4, 4]], {expected: 'rejected', category: 'libc-linking', diagnostic: /Unresolved|undefined|resolve/i}),
  fixture('libc-malloc', '<stdlib.h> declaration exists; malloc/free are not linked', '#include <stdlib.h>\nint32_t run(int32_t x) { int32_t *p = malloc(sizeof(int32_t)); *p = x; int32_t y = *p; free(p); return y; }', [[4, 4]], {expected: 'rejected', category: 'libc-linking', diagnostic: /Unresolved|undefined|resolve/i}),
  fixture('libm-sin', '<math.h> declaration exists; sin is not linked', '#include <math.h>\ndouble run(double x) { return sin(x); }', [[0, 0]], {params: ['double'], result: 'double', expected: 'rejected', category: 'libc-linking', diagnostic: /Unresolved|undefined|resolve/i}),
];

const records = [];
const makeSpec = (entry) => ({
  name: `wcc-syntax-${entry.id}`, description: `Empirically test ${entry.feature}.`,
  exports: [{name: 'run', params: entry.params.map((type, i) => ({name: `a${i}`, type})), result: entry.result}],
  tests: entry.values.map(([arg, expected]) => ({export: 'run', args: entry.params.length ? [arg] : [], ...(entry.result === 'void' ? {} : {expected})})),
});
const tableText = (value) => String(value).replaceAll('|', '\\|');
const renderReport = (report) => '# Embedded wcc syntax observations\n\n' +
  `Compiler: ${report.compiler.name} ${report.compiler.version}; host: ${report.host.platform}/${report.host.arch}; Node ${report.host.node}.\n\n` +
  'This is a bounded set of compile-and-execute examples, not evidence of full C11 conformity. Internal pointer/array/struct examples keep a scalar public ABI. Unsupported public signatures and unresolved libraries are distinct from rejected C syntax. All nonempty compiler stderr, including warnings, rejects the portable build.\n\n' +
  '| Case | Feature | Outcome | Category | Runtime examples passed |\n|---|---|---|---|---:|\n' +
  report.results.map((entry) => `| ${entry.id} | ${tableText(entry.feature)} | ${entry.observed} | ${entry.category} | ${entry.runtime_tests_passed ?? 0} |`).join('\n') + '\n\n' +
  report.results.filter((entry) => entry.diagnostic).map((entry) => `## ${entry.id}\n\n${entry.explanation}\n\n\`\`\`text\n${entry.diagnostic}\n\`\`\`\n`).join('\n') +
  '\nEach case directory contains the exact source and JSON spec. Successful case directories also contain build/module.c, build/module.wasm, build/contract.json, and build/verification.json. results.json includes the exact source text (CRLF escaped where used), spec, diagnostics, and executed test results.\n';

await test('embedded wcc 0.1.13 empirical syntax and portable boundaries', async (suite) => {
  for (const entry of fixtures) {
    await suite.test(`${entry.id}: ${entry.feature}`, async () => {
      const caseDir = path.join(outputRoot, entry.id);
      await mkdir(caseDir);
      const source = entry.line_endings === 'CRLF' ? entry.source.replace(/\n/g, '\r\n') : entry.source;
      const spec = makeSpec(entry);
      const sourcePath = path.join(caseDir, 'source.c');
      const specPath = path.join(caseDir, 'spec.json');
      const outDir = path.join(caseDir, 'build');
      await writeFile(sourcePath, source, 'utf8');
      await writeFile(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
      let diagnostic;
      let verification;
      let contract;
      try {
        await build({source: sourcePath, spec: specPath, outDir});
        verification = JSON.parse(await readFile(path.join(outDir, 'verification.json'), 'utf8'));
        contract = JSON.parse(await readFile(path.join(outDir, 'contract.json'), 'utf8'));
      } catch (error) { diagnostic = error.message; }
      const observed = diagnostic ? 'rejected' : 'accepted';
      const explanation = entry.category === 'public-abi' ? 'Rejected while validating the scalar public specification, before compilation. This says nothing about compiler support for internal C syntax.' :
        entry.category === 'generated-contract' ? 'The build includes generated scalar prototypes before the source. Its diagnostic shows incompatible public declarations, not missing support for internal pointers or variadic syntax.' :
        entry.category === 'libc-linking' ? 'The function/header syntax reaches linking, but this freestanding -nostdlib build supplies no implementation of the referenced library symbol.' :
        diagnostic ? 'The observed compiler diagnostic rejects this particular source in the current portable build. This is not a general C standard conformance claim.' :
        'Compiled with the embedded compiler, matched the declared scalar ABI, and passed every specified runtime example without imports.';
      const record = {id: entry.id, feature: entry.feature, category: entry.category, expected: entry.expected,
        observed, explanation, source_file: sourcePath, spec_file: specPath, source, spec,
        line_endings: entry.line_endings ?? 'LF', diagnostic: diagnostic ?? null,
        expectation_matched: observed === entry.expected && (!entry.diagnostic || entry.diagnostic.test(diagnostic ?? '')),
        runtime_tests_passed: contract?.validation.tests_passed ?? 0,
        imports: contract?.imports ?? null, verification: verification ?? null};
      records.push(record);
      await writeFile(path.join(caseDir, 'result.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
      if (observed === 'accepted') {
        assert.deepEqual(contract.imports, []);
        assert.equal(contract.validation.tests_passed, spec.tests.length);
        assert.equal(verification.passed, true);
      } else {
        await assert.rejects(lstat(outDir), (error) => error.code === 'ENOENT');
      }
      assert.equal(observed, entry.expected, diagnostic);
      if (entry.diagnostic) assert.match(diagnostic ?? '', entry.diagnostic);
    });
  }
});
const report = {compiler: PROVENANCE, host: {platform: process.platform, arch: process.arch, node: process.versions.node},
  artifact_directory: outputRoot, cases: records.length, expectations_passed: records.every((entry) => entry.expectation_matched),
  accepted: records.filter((entry) => entry.observed === 'accepted').length,
  rejected: records.filter((entry) => entry.observed === 'rejected').length,
  runtime_tests_passed: records.reduce((total, entry) => total + entry.runtime_tests_passed, 0), results: records};
assert.equal((await readdir(outputRoot)).some((name) => name.startsWith('.wasm-build-')), false);
await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
await writeFile(path.join(outputRoot, 'results.md'), renderReport(report), 'utf8');
process.stdout.write(JSON.stringify({output_dir: outputRoot, cases: report.cases, accepted: report.accepted,
  rejected: report.rejected, runtime_tests_passed: report.runtime_tests_passed}) + '\n');
