"""Execute the documented Python file-writing/build/ZIP workflow end to end."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent


class AuthoringExample(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("WASM_SKILL_NODE") or shutil.which("node") or shutil.which("nodejs"),
                         "An existing Node.js runtime is required")
    def test_documented_python_workflow(self):
        document = (ROOT / "portable-template" / "references" / "authoring.md").read_text(encoding="utf-8")
        blocks = re.findall(r"```python\n(.*?)\n```", document, re.S)
        self.assertEqual(len(blocks), 1)
        parent = ROOT / ".test-output"
        parent.mkdir(exist_ok=True)
        run_dir = Path(tempfile.mkdtemp(prefix="authoring-example-", dir=parent))
        namespace = {"skill_dir": str(ROOT / "skills" / "c-wasm-portable-wcc"), "host_work_dir": str(run_dir)}
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(compile(blocks[0], "authoring.md", "exec"), namespace)
        result = json.loads(output.getvalue())
        archive = Path(result["zip"])
        self.assertTrue(archive.resolve().is_relative_to(run_dir.resolve()))
        with zipfile.ZipFile(archive) as bundle:
            self.assertIsNone(bundle.testzip())
            self.assertEqual(sorted(bundle.namelist()), ["contract.json", "module.c", "module.spec.json", "module.wasm", "verification.json"])
            verification = json.loads(bundle.read("verification.json"))
            self.assertTrue(verification["passed"])
            self.assertEqual([test["actual"] for test in verification["tests"]], [5, 0])
        (run_dir / "result.json").write_text(json.dumps({"passed": True, **result}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
