"""Check ZIP contents, SDK hashes, native ELF host types, and script parity."""
from pathlib import Path
import argparse
import hashlib
import json
import struct
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "toolchains.json").read_text(encoding="utf-8"))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("arch", nargs="?", default="all", choices=["all", "x64", "arm64"])
selected = parser.parse_args().arch
report = []
for arch, machine in (("x64", 62), ("arm64", 183)):
    if selected != "all" and selected != arch:
        continue
    name = f"c-wasm-linux-{arch}"
    archive = ROOT / "dist" / f"{name}.zip"
    expected = manifest["hosts"][arch]
    with zipfile.ZipFile(archive) as package:
        bad = package.testzip()
        assert bad is None, f"Bad ZIP CRC: {bad}"
        host = json.loads(package.read(f"{name}/host.json"))
        assert host["arch"] == arch and host["platform"] == "linux"
        assert host["archiveSha256"] == expected["archiveSha256"]
        assert package.read(f"{name}/LICENSE.txt") == (ROOT / "LICENSE").read_bytes()
        assert package.read(f"{name}/NOTICE.txt") == (ROOT / "NOTICE").read_bytes()
        for file in ("build.mjs", "wasm.mjs", "verify.mjs", "prepare.mjs"):
            assert package.read(f"{name}/scripts/{file}") == (ROOT / "src" / file).read_bytes()
        digest = hashlib.sha256()
        with package.open(f"{name}/toolchain/wasi-sdk.tar.gz") as embedded:
            for chunk in iter(lambda: embedded.read(1024 * 1024), b""):
                digest.update(chunk)
        assert digest.hexdigest() == expected["archiveSha256"], "Embedded SDK checksum mismatch"
    with tarfile.open(ROOT / ".cache" / expected["archive"], "r:gz") as sdk:
        native_arch = "x86_64" if arch == "x64" else "arm64"
        compiler = sdk.getmember(f"wasi-sdk-34.0-{native_arch}-linux/bin/clang-23")
        assert compiler.mode & 0o111, "Native compiler must have execute permissions"
        with sdk.extractfile(compiler) as binary:
            elf_header = binary.read(20)
        assert elf_header[:4] == b"\x7fELF"
        assert struct.unpack("<H", elf_header[18:20])[0] == machine, "Wrong native host architecture"
    report.append({"arch": arch, "zip": str(archive.relative_to(ROOT)), "bytes": archive.stat().st_size, "sdk_sha256": digest.hexdigest(), "elf_machine": machine, "zip_crc_valid": True, "scripts_match_source": True})
print(json.dumps({"packages": report}, indent=2))
