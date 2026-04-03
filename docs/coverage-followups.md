Coverage follow-ups for src/bot (SB-0MNFT3MI1005HXOD)

Summary of local run

- Test coverage for src/bot (cli-runner.ts) is currently 76.22% (statements/lines/functions/branches below 80%).
- CI will now run coverage and fail if threshold is not met.

Proposed follow-up work items

1) Add unit tests to cover uncovered branches and lines in src/bot/cli-runner.ts
   - Focus areas: error handling branches, timeout behavior, child process termination paths.
   - Estimated effort: small (2-4 tests per area).

2) Add integration tests for edge-case CLI outputs (invalid NDJSON lines, stderr-only errors)
   - Use vi.mock for child_process.spawn to simulate CLI behaviour.
   - Ensure last-event mapping and failed path exercised.

3) Add test utility to reset and restore setCliPath / process.env between tests
   - Ensure no cross-test leakage of CLI path.

If you want, I can create these follow-up work items in the worklog and begin implementing the highest-priority tests.
