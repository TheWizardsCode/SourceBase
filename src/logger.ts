import pino from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";

const logLevelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function envLogLevel(defaultLevel: LogLevel = "info"): LogLevel {
  const env = (process.env.LOG_LEVEL || "").toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") {
    return env as LogLevel;
  }
  return defaultLevel;
}

// Create a root pino instance. In development enable pretty printing.
const isDev = process.env.NODE_ENV !== "production";
const transport = isDev
  ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
  : undefined;

// pino's typings/export shape can vary between versions and build setups.
// Cast to any for the factory call to keep runtime behaviour while satisfying
// TypeScript in environments where the module isn't callable according to the
// type definitions.
const pinoLogger = (pino as any)(
  {
    level: envLogLevel("info")
  },
  transport ? (pino as any).transport(transport as any) : undefined
);

export class Logger {
  constructor(private readonly level: LogLevel = envLogLevel("info")) {}

  private shouldLog(level: LogLevel): boolean {
    return logLevelOrder[level] >= logLevelOrder[this.level];
  }

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (!this.shouldLog(level)) {
      return;
    }

    // Use pino to emit structured logs.
    try {
      const fn = (pinoLogger as any)[level];
      if (meta !== undefined) {
        fn.call(pinoLogger, { meta }, message);
      } else {
        fn.call(pinoLogger, message);
      }
    } catch (e) {
      // If pino isn't available for some reason, fall back to console below.
    }

    // Preserve previous behaviour for consumers and tests: write JSON to console.
    const record: Record<string, unknown> = { level, message };
    if (meta !== undefined) {
      record.meta = meta;
    }

    if (level === "error") {
      console.error(JSON.stringify(record));
      return;
    }

    console.log(JSON.stringify(record));
  }
}
