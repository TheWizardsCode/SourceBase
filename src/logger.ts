export type LogLevel = "debug" | "info" | "warn" | "error";

const logLevelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(private readonly level: LogLevel = "info") {}

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

    const record = {
      level,
      message,
      ...(meta ? { meta } : {})
    };

    if (level === "error") {
      console.error(JSON.stringify(record));
      return;
    }

    console.log(JSON.stringify(record));
  }
}
