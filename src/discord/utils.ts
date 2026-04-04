import os from "os";

export function makeTempFileName(prefix = "briefing", ext = "md") {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  return `${os.tmpdir()}/${name}`;
}

/**
 * Build a verbose CLI error report suitable for posting to a Discord thread.
 * Keeps the message compact but includes actionable debugging details.
 */
export function buildCliErrorReport(params: { command: string; args: string[]; exitCode?: number; stderr?: string; spawnError?: string; note?: string; }): string {
  const lines: string[] = [];
  lines.push("⚠️ CLI Error Report");
  lines.push("");
  lines.push(`Command: \`${params.command} ${params.args.map(a => String(a)).join(' ')}\``);
  if (params.exitCode !== undefined) lines.push(`Exit code: ${params.exitCode}`);
  if (params.spawnError) lines.push(`Spawn error: ${params.spawnError}`);
  if (params.stderr) {
    const stderrSnippet = params.stderr.length > 1500 ? params.stderr.slice(0, 1500) + "\n...(truncated)" : params.stderr;
    lines.push("--- stderr ---");
    lines.push("```\n" + stderrSnippet + "\n```");
  }
  // Best-effort Root Cause Analysis (heuristic)
  try {
    const rca: string[] = [];
    if (params.spawnError) {
      rca.push("The CLI failed to start (spawn error). This often means the executable is missing or lacks execute permission.");
    } else if (params.exitCode !== undefined) {
      if (params.exitCode === -1) {
        rca.push("The CLI timed out or a spawn error occurred (exitCode -1). Check host resource usage and CLI availability.");
      } else if (params.exitCode >= 1 && params.exitCode <= 127) {
        rca.push("The CLI exited with a non-zero status. Inspect stderr for application-level errors (parsing, network, permission issues).");
      }
    }

    if (params.stderr) {
      const s = params.stderr.toLowerCase();
      if (/enoent/.test(s) || /not found/.test(s)) {
        rca.push("ENOENT / not found: the CLI binary could not be located. Verify OB_CLI_PATH or PATH on the host.");
      }
      if (/eacces|permission denied/.test(s)) {
        rca.push("Permission denied: the CLI binary or a required resource lacks execute/read permission.");
      }
      if (/connection refused|failed to connect|timeout/.test(s)) {
        rca.push("Network related error: the CLI attempted an outbound connection and failed. Check network connectivity and proxies.");
      }
      if (/out of memory|killed/.test(s)) {
        rca.push("Process killed / OOM: the host may be under memory pressure.");
      }
    }

    if (rca.length > 0) {
      lines.push("");
      lines.push("--- Best-effort Root Cause Analysis ---");
      for (const l of rca) lines.push(`- ${l}`);
    }
  } catch {
    // non-fatal: ignore any issues while producing RCA
  }

  // Suggested next steps for maintainers
  lines.push("");
  lines.push("--- Suggested Next Steps ---");
  lines.push("1. Check the bot host for the ob/OpenBrain CLI binary and ensure it is on PATH or OB_CLI_PATH is set correctly.");
  lines.push("2. If the error includes 'permission denied' or ENOENT, verify file permissions and executable presence.");
  lines.push("3. Re-run the failing command manually on the host to reproduce and gather full logs: e.g. `ob ${params.command} ${params.args.join(' ')}`.");
  lines.push("4. If the CLI reports application errors, include the stderr snippet above when filing an issue.");
  if (params.note) lines.push(`Note: ${params.note}`);
  lines.push("");
  lines.push("If this keeps happening, please check the host where the bot is running for the OpenBrain CLI and ensure it is accessible. Include the above information when reporting the issue.");
  return lines.join("\n");
}
