import type { AddProgressEvent, AddResult } from "../../src/bot/cli-runner.js";
export function createAddGenerator(events?: AddProgressEvent[], result?: AddResult): AsyncGenerator<AddProgressEvent, AddResult, void>;
