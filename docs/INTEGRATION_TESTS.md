Integration tests and shims
===========================

This file documents the minimal integration-test shim and how to run the integration tests locally.

Shim
----
A lightweight Node shim is provided at test-shims/ob-ndjson-shim.js. It mimics the CLI by writing NDJSON progress events to stdout, optionally writing lines to stderr, and exiting with a configurable exit code.

Running integration tests
-------------------------
1. Ensure dependencies are installed: `npm install`.
2. Run the integration tests: `npm run test:integration`.

Notes
-----
- The shim is invoked automatically when `OB_CLI_PATH` points at the shim file (the runner will spawn Node for `.js` paths).
- The integration tests are intentionally small and hermetic; they do not require the real `ob` binary.
