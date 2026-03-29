import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setupGracefulShutdown,
  removeGracefulShutdownHandlers,
  registerShutdownCallback,
  unregisterShutdownCallback,
  getIsShuttingDown,
  gracefulShutdown,
  __resetShutdownState,
} from "../../src/bot/shutdown.js";
import * as cliRunner from "../../src/bot/cli-runner.js";

// ============================================================================
// Mock cli-runner
// ============================================================================

vi.mock("../../src/bot/cli-runner.js", () => ({
  getActiveChildProcessCount: vi.fn(),
  terminateAllChildProcesses: vi.fn(),
}));

// ============================================================================
// Tests
// ============================================================================

describe("Shutdown Handler", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const createMockExit = () => vi.fn<(code: number) => never>();

  beforeEach(() => {
    vi.clearAllMocks();
    removeGracefulShutdownHandlers();
    __resetShutdownState();
    vi.mocked(cliRunner.getActiveChildProcessCount).mockReturnValue(0);
    vi.mocked(cliRunner.terminateAllChildProcesses).mockResolvedValue(undefined);
  });

  afterEach(() => {
    removeGracefulShutdownHandlers();
    __resetShutdownState();
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Callback Registration
  // ==========================================================================

  describe("registerShutdownCallback", () => {
    it("should register a callback to be executed during shutdown", async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const mockExit = createMockExit();
      registerShutdownCallback(callback);

      await gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);

      expect(callback).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("should register multiple callbacks", async () => {
      const callback1 = vi.fn().mockResolvedValue(undefined);
      const callback2 = vi.fn().mockResolvedValue(undefined);
      const mockExit = createMockExit();

      registerShutdownCallback(callback1);
      registerShutdownCallback(callback2);

      await gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe("unregisterShutdownCallback", () => {
    it("should unregister a previously registered callback", async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const mockExit = createMockExit();
      
      registerShutdownCallback(callback);
      unregisterShutdownCallback(callback);

      await gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Graceful Shutdown
  // ==========================================================================

  describe("gracefulShutdown", () => {
    it("should terminate child processes if any are active", async () => {
      vi.mocked(cliRunner.getActiveChildProcessCount).mockReturnValue(3);
      const mockExit = createMockExit();

      await gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);

      expect(cliRunner.terminateAllChildProcesses).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith("Terminating 3 active CLI child process(es)...");
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("should skip child process termination if none are active", async () => {
      vi.mocked(cliRunner.getActiveChildProcessCount).mockReturnValue(0);
      const mockExit = createMockExit();

      await gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);

      expect(cliRunner.terminateAllChildProcesses).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("should execute all registered callbacks", async () => {
      const callback1 = vi.fn().mockResolvedValue(undefined);
      const callback2 = vi.fn().mockResolvedValue(undefined);
      const mockExit = createMockExit();

      registerShutdownCallback(callback1);
      registerShutdownCallback(callback2);

      await gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it("should continue shutdown even if callbacks fail", async () => {
      const failingCallback = vi.fn().mockRejectedValue(new Error("Callback failed"));
      const mockExit = createMockExit();
      
      registerShutdownCallback(failingCallback);

      await gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);

      expect(failingCallback).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Shutdown callback 0 failed",
        expect.any(Object)
      );
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("should handle callback timeout gracefully", async () => {
      const slowCallback = vi.fn().mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 20000))
      );
      const mockExit = createMockExit();
      
      registerShutdownCallback(slowCallback);

      await gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Some shutdown callbacks timed out",
        expect.any(Object)
      );
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("should force exit if shutdown is already in progress", async () => {
      const mockExit = createMockExit();

      // First shutdown call - this will complete and call exit
      const firstShutdown = gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);
      
      // Second shutdown call while first is in progress
      await gracefulShutdown("SIGINT", 0, mockLogger, mockExit);

      // Second call should exit with 1
      expect(mockExit).toHaveBeenCalledWith(1);
      
      // Wait for first shutdown to complete
      await firstShutdown.catch(() => {});
    });

    it("should exit with provided exit code", async () => {
      const mockExit = createMockExit();

      await gracefulShutdown("SIGTERM", 42, mockLogger, mockExit);

      expect(mockExit).toHaveBeenCalledWith(42);
    });

    it("should handle errors during shutdown", async () => {
      // Reset and set up rejection
      vi.mocked(cliRunner.terminateAllChildProcesses).mockReset();
      vi.mocked(cliRunner.terminateAllChildProcesses).mockRejectedValue(new Error("Termination failed"));
      
      // Need active processes to trigger terminateAllChildProcesses
      vi.mocked(cliRunner.getActiveChildProcessCount).mockReturnValue(1);
      
      const mockExit = createMockExit();

      await gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Error during graceful shutdown",
        expect.any(Object)
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should work without a logger", async () => {
      const mockExit = createMockExit();

      // Should not throw
      await gracefulShutdown("SIGTERM", 0, undefined, mockExit);

      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  // ==========================================================================
  // Signal Handlers Setup
  // ==========================================================================

  describe("setupGracefulShutdown", () => {
    it("should register SIGTERM handler", () => {
      setupGracefulShutdown(mockLogger);

      const sigtermListeners = process.listeners("SIGTERM");
      expect(sigtermListeners.length).toBeGreaterThan(0);
    });

    it("should register SIGINT handler", () => {
      setupGracefulShutdown(mockLogger);

      const sigintListeners = process.listeners("SIGINT");
      expect(sigintListeners.length).toBeGreaterThan(0);
    });

    it("should register uncaughtException handler", () => {
      setupGracefulShutdown(mockLogger);

      const exceptionListeners = process.listeners("uncaughtException");
      expect(exceptionListeners.length).toBeGreaterThan(0);
    });

    it("should register unhandledRejection handler", () => {
      setupGracefulShutdown(mockLogger);

      const rejectionListeners = process.listeners("unhandledRejection");
      expect(rejectionListeners.length).toBeGreaterThan(0);
    });
  });

  describe("removeGracefulShutdownHandlers", () => {
    it("should remove all signal handlers", () => {
      setupGracefulShutdown(mockLogger);

      expect(process.listeners("SIGTERM").length).toBeGreaterThan(0);
      expect(process.listeners("SIGINT").length).toBeGreaterThan(0);
      expect(process.listeners("uncaughtException").length).toBeGreaterThan(0);
      expect(process.listeners("unhandledRejection").length).toBeGreaterThan(0);

      removeGracefulShutdownHandlers();

      expect(process.listeners("SIGTERM").length).toBe(0);
      expect(process.listeners("SIGINT").length).toBe(0);
      expect(process.listeners("uncaughtException").length).toBe(0);
      expect(process.listeners("unhandledRejection").length).toBe(0);
    });
  });

  // ==========================================================================
  // State Tracking
  // ==========================================================================

  describe("getIsShuttingDown", () => {
    it("should return false initially", () => {
      expect(getIsShuttingDown()).toBe(false);
    });

    it("should return true after shutdown is initiated", async () => {
      const mockExit = createMockExit();

      expect(getIsShuttingDown()).toBe(false);

      // Don't await - we want to check state during shutdown
      const shutdownPromise = gracefulShutdown("SIGTERM", 0, mockLogger, mockExit);
      
      expect(getIsShuttingDown()).toBe(true);

      await shutdownPromise;
    });
  });
});
