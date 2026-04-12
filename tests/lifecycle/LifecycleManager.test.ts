import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LifecycleManager, type LifecycleManagerConfig } from "../../src/lifecycle/LifecycleManager.js";
import type { Logger } from "../../src/log/index.js";
import type { Client, Channel, TextChannel } from "discord.js";

describe("LifecycleManager", () => {
  let mockLogger: Logger;
  let mockClient: Client;
  let config: LifecycleManagerConfig;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    mockClient = {
      channels: {
        fetch: vi.fn(),
      },
    } as unknown as Client;

    config = {
      logger: mockLogger,
      client: mockClient,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("initialization", () => {
    it("should initialize with default values", () => {
      const manager = new LifecycleManager(config);

      expect(manager.shuttingDown).toBe(false);
      expect(manager.isStarted).toBe(false);
    });

    it("should initialize with custom shutdown config", () => {
      const manager = new LifecycleManager({
        ...config,
        shutdownConfig: {
          timeoutMs: 60000,
          cleanupStatusMessages: false,
          performLostItemRecovery: false,
        },
      });

      expect(manager).toBeDefined();
    });
  });

  describe("startup sequence", () => {
    it("should complete startup sequence successfully", async () => {
      const manager = new LifecycleManager(config);

      await manager.performStartup();

      expect(manager.isStarted).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith("Beginning startup sequence");
      expect(mockLogger.info).toHaveBeenCalledWith("Startup sequence completed successfully");
    });

    it("should skip startup if already completed", async () => {
      const manager = new LifecycleManager(config);

      await manager.performStartup();
      await manager.performStartup();

      expect(mockLogger.warn).toHaveBeenCalledWith("Startup already completed, skipping");
    });

    it("should call event listeners during startup", async () => {
      const onStartupBegin = vi.fn();
      const onStartupComplete = vi.fn();

      const manager = new LifecycleManager({
        ...config,
        eventListeners: {
          onStartupBegin,
          onStartupComplete,
        },
      });

      await manager.performStartup();

      expect(onStartupBegin).toHaveBeenCalled();
      expect(onStartupComplete).toHaveBeenCalled();
    });

    it("should throw if startup fails", async () => {
      const onStartupBegin = vi.fn().mockRejectedValue(new Error("Startup failed"));

      const manager = new LifecycleManager({
        ...config,
        eventListeners: {
          onStartupBegin,
        },
      });

      await expect(manager.performStartup()).rejects.toThrow("Startup failed");
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Startup sequence failed",
        expect.any(Object)
      );
    });
  });

  describe("startup notifications", () => {
    it("should send startup notification when channel is configured", async () => {
      const mockSend = vi.fn().mockResolvedValue(undefined);
      const mockChannel = {
        send: mockSend,
      } as unknown as TextChannel;

      vi.mocked(mockClient.channels.fetch).mockResolvedValue(mockChannel);

      const manager = new LifecycleManager({
        ...config,
        startupNotification: {
          channelId: "123456789",
          message: "Custom startup message",
          includeTimestamp: false,
        },
      });

      await manager.sendStartupNotifications();

      expect(mockClient.channels.fetch).toHaveBeenCalledWith("123456789");
      expect(mockSend).toHaveBeenCalledWith("Custom startup message");
    });

    it("should send default message when no custom message provided", async () => {
      const mockSend = vi.fn().mockResolvedValue(undefined);
      const mockChannel = {
        send: mockSend,
      } as unknown as TextChannel;

      vi.mocked(mockClient.channels.fetch).mockResolvedValue(mockChannel);

      const manager = new LifecycleManager({
        ...config,
        startupNotification: {
          channelId: "123456789",
          includeTimestamp: false,
        },
      });

      await manager.sendStartupNotifications();

      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining("Bot is now online"));
    });

    it("should include timestamp when configured", async () => {
      const mockSend = vi.fn().mockResolvedValue(undefined);
      const mockChannel = {
        send: mockSend,
      } as unknown as TextChannel;

      vi.mocked(mockClient.channels.fetch).mockResolvedValue(mockChannel);

      const manager = new LifecycleManager({
        ...config,
        startupNotification: {
          channelId: "123456789",
          includeTimestamp: true,
        },
      });

      await manager.sendStartupNotifications();

      expect(mockSend).toHaveBeenCalledWith(expect.stringMatching(/at \d{4}-\d{2}-\d{2}T/));
    });

    it("should handle channel not found gracefully", async () => {
      vi.mocked(mockClient.channels.fetch).mockResolvedValue(null);

      const manager = new LifecycleManager({
        ...config,
        startupNotification: {
          channelId: "123456789",
        },
      });

      await manager.sendStartupNotifications();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Startup notification channel not found or not sendable",
        expect.any(Object)
      );
    });

    it("should handle non-sendable channel gracefully", async () => {
      const mockChannel = {} as unknown as Channel;
      vi.mocked(mockClient.channels.fetch).mockResolvedValue(mockChannel);

      const manager = new LifecycleManager({
        ...config,
        startupNotification: {
          channelId: "123456789",
        },
      });

      await manager.sendStartupNotifications();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Startup notification channel not found or not sendable",
        expect.any(Object)
      );
    });

    it("should handle channel fetch errors gracefully", async () => {
      vi.mocked(mockClient.channels.fetch).mockRejectedValue(new Error("Network error"));

      const manager = new LifecycleManager({
        ...config,
        startupNotification: {
          channelId: "123456789",
        },
      });

      await manager.sendStartupNotifications();

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to send startup notification",
        expect.any(Object)
      );
    });

    it("should skip notification when no channel configured", async () => {
      const manager = new LifecycleManager(config);

      await manager.sendStartupNotifications();

      expect(mockLogger.debug).toHaveBeenCalledWith("No startup notification channel configured, skipping");
      expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    });
  });

  describe("startup recovery", () => {
    it("should perform startup recovery and return result", async () => {
      const manager = new LifecycleManager(config);

      const result = await manager.performStartupRecovery();

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(0);
      expect(result.errors).toEqual([]);
      expect(mockLogger.info).toHaveBeenCalledWith("Performing startup recovery");
      expect(mockLogger.info).toHaveBeenCalledWith("Startup recovery completed", expect.any(Object));
    });
  });

  describe("status message management", () => {
    it("should register and unregister status messages", () => {
      const manager = new LifecycleManager(config);
      const state = {
        messageId: "msg123",
        channelId: "chan456",
        content: "Test message",
        url: "https://example.com",
      };

      manager.registerStatusMessage("key1", state);

      const messages = manager.getStatusMessages();
      expect(messages.get("key1")).toEqual(state);

      manager.unregisterStatusMessage("key1");
      expect(manager.getStatusMessages().has("key1")).toBe(false);
    });

    it("should clear all status messages", () => {
      const manager = new LifecycleManager(config);

      manager.registerStatusMessage("key1", {
        messageId: "msg1",
        channelId: "chan1",
        content: "Message 1",
      });
      manager.registerStatusMessage("key2", {
        messageId: "msg2",
        channelId: "chan2",
        content: "Message 2",
      });

      expect(manager.getStatusMessages().size).toBe(2);

      manager.clearStatusMessages();

      expect(manager.getStatusMessages().size).toBe(0);
    });

    it("should restore status messages during startup", async () => {
      const manager = new LifecycleManager(config);

      await manager.restoreStatusMessages();

      expect(mockLogger.info).toHaveBeenCalledWith("Restoring status messages");
      expect(mockLogger.info).toHaveBeenCalledWith("Status message restoration completed", expect.any(Object));
    });
  });

  describe("shutdown callbacks", () => {
    let mockExit: { mockRestore: () => void };

    beforeEach(() => {
      // Mock process.exit to prevent tests from exiting
      mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        // Do nothing - prevent actual exit
        return undefined as never;
      });
    });

    afterEach(() => {
      mockExit.mockRestore();
    });

    it("should register and execute shutdown callbacks", async () => {
      const manager = new LifecycleManager({
        ...config,
        shutdownConfig: {
          timeoutMs: 1000,
          cleanupStatusMessages: false,
          performLostItemRecovery: false,
        },
      });

      const callback1 = vi.fn().mockResolvedValue(undefined);
      const callback2 = vi.fn().mockResolvedValue(undefined);

      manager.onShutdown(callback1);
      manager.onShutdown(callback2);

      // Trigger shutdown
      manager.performGracefulShutdown("SIGTERM");
      
      // Wait a bit for callbacks to execute
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it("should handle callback errors gracefully", async () => {
      const manager = new LifecycleManager({
        ...config,
        shutdownConfig: {
          timeoutMs: 1000,
          cleanupStatusMessages: false,
          performLostItemRecovery: false,
        },
      });

      const failingCallback = vi.fn().mockRejectedValue(new Error("Callback failed"));
      manager.onShutdown(failingCallback);

      // Trigger shutdown
      manager.performGracefulShutdown("SIGTERM");
      
      // Wait a bit for callbacks to execute
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Shutdown callback failed",
        expect.any(Object)
      );
    });
  });

  describe("graceful shutdown", () => {
    let mockExit: { mockRestore: () => void };

    beforeEach(() => {
      // Mock process.exit to prevent tests from exiting
      mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        return undefined as never;
      });
    });

    afterEach(() => {
      mockExit.mockRestore();
    });

    it("should set shuttingDown flag when shutdown starts", async () => {
      const manager = new LifecycleManager({
        ...config,
        shutdownConfig: {
          timeoutMs: 1000,
          cleanupStatusMessages: false,
          performLostItemRecovery: false,
        },
      });

      expect(manager.shuttingDown).toBe(false);

      // Trigger shutdown
      manager.performGracefulShutdown("SIGTERM");

      expect(manager.shuttingDown).toBe(true);
    });

    it("should call event listeners during shutdown", async () => {
      const onShutdownBegin = vi.fn();
      const onShutdownComplete = vi.fn();

      const manager = new LifecycleManager({
        ...config,
        shutdownConfig: {
          timeoutMs: 1000,
          cleanupStatusMessages: false,
          performLostItemRecovery: false,
        },
        eventListeners: {
          onShutdownBegin,
          onShutdownComplete,
        },
      });

      // Trigger shutdown
      manager.performGracefulShutdown("SIGTERM");
      
      // Wait a bit for listeners to be called
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(onShutdownBegin).toHaveBeenCalledWith("SIGTERM");
    });

    it("should log appropriate messages during shutdown", async () => {
      const manager = new LifecycleManager({
        ...config,
        shutdownConfig: {
          timeoutMs: 1000,
          cleanupStatusMessages: false,
          performLostItemRecovery: false,
        },
      });

      // Trigger shutdown
      manager.performGracefulShutdown("SIGINT");
      
      // Wait a bit for logging to occur
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Starting graceful shutdown")
      );
    });
  });

  describe("force shutdown", () => {
    it("should log warning when force shutdown is called", () => {
      const manager = new LifecycleManager(config);

      // Mock process.exit to prevent test from exiting
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("Process exit called");
      });

      expect(() => manager.forceShutdown(1)).toThrow("Process exit called");
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Force shutdown initiated with exit code 1"
      );

      mockExit.mockRestore();
    });

    it("should use custom exit code", () => {
      const manager = new LifecycleManager(config);

      // Mock process.exit to prevent test from exiting
      const mockExit = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`Process exit called with code ${code}`);
      });

      expect(() => manager.forceShutdown(42)).toThrow("Process exit called with code 42");

      mockExit.mockRestore();
    });
  });
});
