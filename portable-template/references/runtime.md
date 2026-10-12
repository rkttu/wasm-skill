# Copilot upload and execution

The candidate is a Python-entry Agent Skill, packaged as a root-layout ZIP. Its embedded compiler is Wasm executed by Node's built-in WASI; no native x64/arm64 compiler is included. Python only launches Node; it does not compile C independently.

Upload the ZIP through the intended Copilot Studio Agent Skills UI, then ask the agent to run `scripts/run.py doctor --self-test` through its Python execution capability. A successful local test is not proof of execution inside Copilot Studio. This requires Python subprocess creation, an accessible Node.js 22+ executable, WASI, workers, and a writable filesystem in that environment.

The Microsoft Copilot Studio Agent Skills upload documentation accepts ZIP files with SKILL.md and supporting resources, but does not specify a Node.js/WASI execution guarantee. The separate Microsoft 365 Agent Builder custom skills documentation states a 50 MB compressed ZIP limit and an extension allowlist. This package uses Python/JavaScript/text resources, fewer than 350 files, depth at most three, and each file below 25 MB to keep the upload candidate conservative. Compiler bytes are ordinary base64 module data in `compiler-data.mjs`; the uploaded resources contain no standalone native executables or .wasm files. Tenant upload filtering and actual execution are unverified.

If upload succeeds but subprocess/Node is unavailable, retain the source/spec and report the concrete diagnostic; this workflow cannot produce validated Wasm in that host without the runtime prerequisites. Runtime downloads and package installation are not required or attempted.

Official references:

- [Copilot Studio: add existing skills](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/skills-add-existing)
- [Microsoft 365: declarative agent skills](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-skills)
- [Node.js WASI](https://nodejs.org/api/wasi.html)
- [wcc compiler](https://github.com/tyfkda/xcc)
