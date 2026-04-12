export { Logger, type LogLevel } from "../logger.js";

// Future: this module is the canonical export point for logging. Other modules
// should import from "src/log" so the implementation can be swapped or
// restructured without touching many files.
