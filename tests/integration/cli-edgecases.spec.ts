import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

describe('Integration: CLI edge-cases (NDJSON/stderr/exit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OB_CLI_PATH;
    vi.resetModules();
  });

  afterEach(async () => {
    const mod = await import('../../src/bot/cli-runner.js');
    await mod.terminateAllChildProcesses();
  });

  it('consumes NDJSON from a shim and returns success', async () => {
    const { withObCliPath } = await import('../helpers/obCliEnv.js');
    await withObCliPath(path.resolve('./test-shims/ob-ndjson-shim.js'), async () => {
      const mod = await import('../../src/bot/cli-runner.js');

      const gen = mod.runAddCommand('https://example.test');
      const events: any[] = [];
      let result: any;

      // iterate generator to completion
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const res = await gen.next();
        if (res.done) {
          result = res.value;
          break;
        }
        events.push(res.value);
      }

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  it('captures stderr emitted by shim and surfaces on non-zero exit', async () => {
    const { withObCliPath } = await import('../helpers/obCliEnv.js');
    await withObCliPath(path.resolve('./test-shims/ob-ndjson-shim.js'), async () => {
      const mod = await import('../../src/bot/cli-runner.js');

      // The shim supports --stderr and --exit flags; pass them via runCliCommand
      const result = await mod.runCliCommand('add', ['--format', 'ndjson', 'https://example.test', '--stderr', 'simulated error', '--exit', '2']);

      // Expect exitCode 2 and stderr included
      expect(result.exitCode).toBe(2);
      expect(String(result.stderr)).toContain('simulated error');
    });
  });
});
