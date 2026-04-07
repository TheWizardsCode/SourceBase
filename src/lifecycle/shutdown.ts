import type { Logger } from "../logger.js";

export interface ShutdownController {
  readonly isShuttingDown: () => boolean;
}

export function createShutdownController(logger: Logger): ShutdownController {
  let shuttingDown = false;

  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.info("Shutdown already in progress, forcing exit");
      process.exit(1);
      return;
    }

    shuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    try {
      logger.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error("Error during graceful shutdown", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });

  return {
    isShuttingDown: () => shuttingDown,
  };
}
