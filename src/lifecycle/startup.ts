import type { Logger } from "../log/index.js";

export async function startBot(start: () => Promise<void>, logger: Logger): Promise<void> {
  try {
    await start();
    logger.info("Bot started successfully");
  } catch (error) {
    logger.error("Bot startup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
