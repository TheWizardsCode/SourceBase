import { EventEmitter } from "events";
import { Readable } from "stream";
import type { ChildProcess } from "child_process";

// Lightweight helpers to create ChildProcess-like fakes for tests.
// Exported factory helpers return { mockSpawn, spawnCalls } so tests can
// inspect what executable/args were invoked.

type SpawnCall = { exe: string; args: string[]; opts: any };

function makeFakeChild(options: {
  stdoutLines?: string[];
  stderrLines?: string[];
  exitCode?: number;
  emitError?: NodeJS.ErrnoException | null;
  onKillExitCode?: number;
}): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  (child as any).stdout = stdout;
  (child as any).stderr = stderr;
  (child as any).exitCode = null;
  (child as any).signalCode = null;

  // Default kill: emit exit after being called (useful for timeout tests)
  (child as any).kill = (signal?: string) => {
    setTimeout(() => {
      const code = options.onKillExitCode ?? 0;
      (child as any).exitCode = code;
      child.emit("exit", code);
    }, 0);
    return true;
  };

  // Schedule stdout/stderr emissions
  setTimeout(() => {
    if (options.emitError) {
      child.emit("error", options.emitError);
      // close streams so readline/iterators can finish
      try {
        stdout.push(null);
        stderr.push(null);
      } catch {}
      return;
    }

    for (const line of options.stdoutLines ?? []) {
      stdout.push(line + "\n");
    }
    for (const line of options.stderrLines ?? []) {
      stderr.push(line + "\n");
    }

    try {
      stdout.push(null);
      stderr.push(null);
    } catch {}

    const code = options.exitCode ?? 0;
    setTimeout(() => child.emit("exit", code), 0);
  }, 0);

  return child;
}

export function createSpawnMockVersion(): { mockSpawn: (exe: string, args: string[], opts: any) => ChildProcess; spawnCalls: SpawnCall[] } {
  const spawnCalls: SpawnCall[] = [];

  const mockSpawn = (exe: string, args: string[], opts: any) => {
    spawnCalls.push({ exe, args, opts });
    // Simulate --version output
    const child = makeFakeChild({ stdoutLines: ["v1.2.3"], exitCode: 0 });
    return child;
  };

  return { mockSpawn, spawnCalls };
}

export function createSpawnMockSimple(): { mockSpawn: (exe: string, args: string[], opts: any) => ChildProcess; spawnCalls: SpawnCall[] } {
  const spawnCalls: SpawnCall[] = [];
  const mockSpawn = (exe: string, args: string[], opts: any) => {
    spawnCalls.push({ exe, args, opts });
    const child = makeFakeChild({ stdoutLines: [], exitCode: 0 });
    return child;
  };
  return { mockSpawn, spawnCalls };
}

export function createSpawnMockNdjson(stdoutObjects: unknown[]): { mockSpawn: (exe: string, args: string[], opts: any) => ChildProcess; spawnCalls: SpawnCall[] } {
  const spawnCalls: SpawnCall[] = [];
  const mockSpawn = (exe: string, args: string[], opts: any) => {
    spawnCalls.push({ exe, args, opts });
    const lines = stdoutObjects.map((o) => JSON.stringify(o));
    const child = makeFakeChild({ stdoutLines: lines, exitCode: 0 });
    return child;
  };
  return { mockSpawn, spawnCalls };
}

export function createSpawnMockInvalidThenValid(invalidLine: string, validObject: unknown) {
  const spawnCalls: SpawnCall[] = [];
  const mockSpawn = (exe: string, args: string[], opts: any) => {
    spawnCalls.push({ exe, args, opts });
    const lines = [invalidLine, JSON.stringify(validObject)];
    const child = makeFakeChild({ stdoutLines: lines, exitCode: 0 });
    return child;
  };
  return { mockSpawn, spawnCalls };
}

export function createSpawnMockSpawnError(code = "ENOENT"): { mockSpawn: (exe: string, args: string[], opts: any) => ChildProcess; spawnCalls: SpawnCall[] } {
  const spawnCalls: SpawnCall[] = [];
  const mockSpawn = (exe: string, args: string[], opts: any) => {
    spawnCalls.push({ exe, args, opts });
    const err: NodeJS.ErrnoException = new Error("spawn " + code);
    err.code = code;
    const child = makeFakeChild({ emitError: err });
    return child;
  };
  return { mockSpawn, spawnCalls };
}

export function createSpawnMockWithStderr(stderrLines: string[], exitCode = 1) {
  const spawnCalls: SpawnCall[] = [];
  const mockSpawn = (exe: string, args: string[], opts: any) => {
    spawnCalls.push({ exe, args, opts });
    const child = makeFakeChild({ stdoutLines: [], stderrLines, exitCode });
    return child;
  };
  return { mockSpawn, spawnCalls };
}

export async function doMockChildProcess(vi: any, mockSpawn: (exe: string, args: string[], opts: any) => ChildProcess) {
  await vi.doMock("child_process", async () => {
    const actual = await vi.importActual<typeof import("child_process")>("child_process");
    return { ...actual, spawn: mockSpawn };
  });
}

// Usage example (TypeScript):
// import { doMockChildProcess, createSpawnMockNdjson } from '../helpers/mockCliSpawn';
// const { mockSpawn, spawnCalls } = createSpawnMockNdjson([{ phase: 'completed', url: 'https://x', title: 't' }]);
// await doMockChildProcess(vi, mockSpawn);
