#!/usr/bin/env node
// Minimal test shim that writes NDJSON progress events to stdout,
// emits diagnostic lines to stderr optionally, and exits with the
// requested code. This shim accepts arguments similar to the real CLI:
//   node test-shims/ob-ndjson-shim.js add --format ndjson <url> [--stderr <line>] [--exit <code>]

const { argv, exit, stderr, stdout } = process;

function usage() {
  console.error('Usage: node ob-ndjson-shim.js add --format ndjson <url> [--stderr <line>] [--exit <code>]');
  exit(2);
}

async function main() {
  const args = argv.slice(2);
  if (args.length < 3) return usage();

  const cmd = args[0];
  const fmtIdx = args.indexOf('--format');
  const fmt = fmtIdx >= 0 ? args[fmtIdx + 1] : undefined;
  const url = args[args.length - 1];

  // parse optional flags
  let stderrLine = null;
  let exitCode = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stderr') {
      stderrLine = args[i + 1];
      i++;
    } else if (args[i] === '--exit') {
      exitCode = parseInt(args[i + 1], 10) || 0;
      i++;
    }
  }

  if (cmd !== 'add' || fmt !== 'ndjson') return usage();

  // Emit a downloading event, then a completed event for the provided URL
  const now = new Date().toISOString();
  stdout.write(JSON.stringify({ phase: 'downloading', url, timestamp: now }) + '\n');
  // small delay to simulate streaming
  await new Promise((r) => setTimeout(r, 10));
  stdout.write(JSON.stringify({ phase: 'completed', url, title: 'Shim Title', id: 123, timestamp: new Date().toISOString() }) + '\n');

  if (stderrLine) {
    stderr.write(stderrLine + '\n');
  }

  exit(exitCode);
}

main().catch((err) => {
  console.error('Shim error:', err);
  exit(1);
});
