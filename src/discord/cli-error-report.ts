const DISCORD_CONTENT_LIMIT = 1900;

export async function postCliErrorReport(target: any, report: string, shortIntro?: string): Promise<void> {
  try {
    if (!report) return;

    if (report.length <= DISCORD_CONTENT_LIMIT) {
      if (typeof target.send === "function") {
        await target.send(report);
        return;
      }
      if (typeof target.reply === "function") {
        await target.reply(report);
        return;
      }
      return;
    }

    const intro = shortIntro || "Detailed CLI diagnostic attached.";
    const content = `${intro}\n\n(Full report attached as cli-error-report.txt)`;
    const file = { attachment: Buffer.from(report, "utf8"), name: "cli-error-report.txt" };

    if (typeof target.send === "function") {
      await target.send({ content, files: [file] } as any);
      return;
    }
    if (typeof target.reply === "function") {
      await target.reply({ content, files: [file] } as any);
      return;
    }
  } catch {
    try {
      const truncated = report.slice(0, Math.max(0, DISCORD_CONTENT_LIMIT - 50)) + "...";
      if (typeof target.send === "function") await target.send(truncated);
      else if (typeof target.reply === "function") await target.reply(truncated);
    } catch {
    }
  }
}
