# Create files and build through Python

Resolve `skill_dir` to the host's extracted skill folder and `host_work_dir` to the host's writable artifact folder. These paths must come from the actual execution environment; `/app/created` is an example only when the host provides that directory. If a Node executable is supplied outside PATH, add `--node /absolute/path/to/node` to each invocation or set `WASM_SKILL_NODE`.

Prefer an available file creation/editing tool or the Python execution tool for C/spec files. Write UTF-8, use `json.dumps` for JSON, and pass subprocess arguments as a list. This avoids an extra shell quoting layer around C comments, quotes, braces, newlines, and preprocessor lines. It also avoids assuming bash heredoc support inside a different host command wrapper.

This complete example builds unsigned addition with defined modulo-2^32 behavior. The two paths are provided by the caller before executing the cell:

```python
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import zipfile

skill = Path(skill_dir).resolve()
work = Path(tempfile.mkdtemp(prefix="wasm-request-", dir=host_work_dir))
entry = skill / "scripts" / "run.py"

def invoke(arguments, timeout):
    result = subprocess.run(
        [sys.executable, str(entry), *arguments],
        capture_output=True, text=True, encoding="utf-8",
        timeout=timeout, shell=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return json.loads(result.stdout)

# Reuse a previous successful doctor result in the same unchanged runtime.
diagnostic = invoke(["doctor", "--self-test"], timeout=90)

source = """#include <stdint.h>
/* Unsigned addition wraps modulo 2^32. */
uint32_t add_u32(uint32_t a, uint32_t b) {
    // No signed integer overflow.
    return a + b;
}
"""
spec = {
    "name": "unsigned-addition",
    "description": "Add two uint32 values modulo 2^32.",
    "exports": [{
        "name": "add_u32",
        "params": [{"name": "a", "type": "uint32_t"},
                   {"name": "b", "type": "uint32_t"}],
        "result": "uint32_t",
    }],
    "tests": [
        {"export": "add_u32", "args": [2, 3], "expected": 5},
        {"export": "add_u32", "args": [4294967295, 1], "expected": 0},
    ],
}
source_path = work / "module.c"
spec_path = work / "module.spec.json"
source_path.write_text(source, encoding="utf-8")
spec_path.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")
output = work / "result"
build = invoke(["build", "--source", str(source_path),
                "--spec", str(spec_path), "--out-dir", str(output)], timeout=450)

archive = work / "unsigned-addition.zip"
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for filename in build["files"]:
        bundle.write(output / filename, arcname=filename)
print(json.dumps({"zip": str(archive), "files": build["files"]}))
```

Use the host's supported download/attachment mechanism for `archive`; printing a path does not create a download link by itself.

On failure, identify the layer from the actual diagnostic:

- File generation: shell quoting/heredoc errors or Python SyntaxError occur before compilation. Use a file tool or correct Python string/JSON construction, and confirm files exist.
- Compilation: errors from `run.py build` include wcc file/line diagnostics. Consult the C syntax profile and the reported line.
- Linking/ABI: unresolved functions, imports, missing exports, or prototype conflicts require changing the source/spec or removing unsupported dependencies.
- Runtime tests: mismatched expected values, traps, or deadlines require reviewing computation and inputs.
- Packaging/delivery: confirm the ZIP entries and use the actual host artifact path/API.

Do not remove valid C comments based solely on a shell error, suppress compiler diagnostics to force a build, or mark an earlier step successful because a later file listing printed.
