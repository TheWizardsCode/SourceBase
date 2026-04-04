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
  if (params.note) lines.push(`Note: ${params.note}`);
  lines.push("");
  lines.push("If this keeps happening, please check the host where the bot is running for the OpenBrain CLI and ensure it is accessible. Include the above information when reporting the issue.");
  return lines.join("\n");
}
