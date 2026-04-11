import type { Logger } from "../logger.js";

export interface ShutdownController {
  readonly isShuttingDown: () => boolean;
}

export function createShutdownController(logger: Logger): ShutdownController {
  let shuttingDown = false;

  // Use a shared symbol on the process object to ensure we only register
  // signal handlers once across the whole process. Tests may create many
  // controllers which would otherwise add multiple listeners and trigger
  // EventEmitter max listeners warnings.
  const SIGNAL_HANDLERS_KEY = Symbol.for("SourceBase.signalHandlersInstalled");
  if ((process as any)[SIGNAL_HANDLERS_KEY]) {
    return {
      isShuttingDown: () => shuttingDown,
    };
  }
  (process as any)[SIGNAL_HANDLERS_KEY] = true;

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
