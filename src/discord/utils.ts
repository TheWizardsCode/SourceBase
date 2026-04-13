import os from "os";

export function makeTempFileName(prefix = "briefing", ext = "md") {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  return `${os.tmpdir()}/${name}`;
}

/**
 * Build a verbose CLI error report suitable for posting to a Discord thread.
 * Keeps the message compact but includes actionable debugging details.
 */
export function buildCliErrorReport(params: { command: string; args: string[]; exitCode?: number; error?: string; stderr?: string; spawnError?: string; note?: string; }): string {
  const lines: string[] = [];
  lines.push("⚠️ CLI Error Report");
  lines.push("");
  lines.push(`Command: \`${params.command} ${params.args.map(a => String(a)).join(' ')}\``);
  if (params.exitCode !== undefined) lines.push(`Exit code: ${params.exitCode}`);
  if (params.spawnError) lines.push(`Spawn error: ${params.spawnError}`);
  
  // Include the error message prominently (this is often the most useful information)
  if (params.error) {
    lines.push("");
    lines.push("--- Error Message ---");
    lines.push("```\n" + params.error + "\n```");
  }
  
  if (params.stderr) {
    const stderrSnippet = params.stderr.length > 1500 ? params.stderr.slice(0, 1500) + "\n...(truncated)" : params.stderr;
    lines.push("");
    lines.push("--- stderr ---");
    lines.push("```\n" + stderrSnippet + "\n```");
  }
  // NOTE: Previously a best-effort root-cause analysis (RCA) was included
  // here that attempted to infer causes from stderr/error message text. It
  // was often inaccurate or misleading, so it has been removed. The report
  // now focuses on providing the raw command, exit code, error message (if
  // any), and a stderr snippet which are the most actionable items.

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
