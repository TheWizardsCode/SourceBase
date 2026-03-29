import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { DocumentQueue, type QueueUpdateStatus } from "../src/cli/lib/ingestion/queue.js";
import { DocumentQueueRepository } from "../src/cli/lib/db/queue-repository.js";
import type { Logger } from "../src/logger.js";
import type { IngestionService } from "../src/cli/lib/ingestion/service.js";

describe("DocumentQueue - restart recovery", () => {
  it("initializes and returns pending items with their Discord metadata", async () => {
    const pool = createFakePool() as unknown as Pool;
    const repository = new DocumentQueueRepository(pool);
    const logger = createFakeLogger();
    const ingestionService = createFakeIngestionService();

    // Pre-populate database with pending items
    await repository.create({
      url: "https://example.com/1",
      sourceId: "msg-1",
      sourceContext: "channel-1",
      authorId: "author-1",
    });
    await repository.create({
      url: "https://example.com/2",
      sourceId: "msg-2",
      sourceContext: "channel-1",
      authorId: "author-1",
    });

    const queue = new DocumentQueue({
      logger,
      ingestionService,
      repository,
    });

    // Initialize should return the pending items for status restoration
    const pendingItems = await queue.initialize();

    expect(pendingItems).toHaveLength(2);
    expect(pendingItems[0].url).toBe("https://example.com/1");
    expect(pendingItems[0].sourceId).toBe("msg-1");
    expect(pendingItems[0].sourceContext).toBe("channel-1");
    expect(pendingItems[1].url).toBe("https://example.com/2");
    expect(pendingItems[1].sourceId).toBe("msg-2");
  });

  it("processes reloaded items after initialization", async () => {
    const pool = createFakePool() as unknown as Pool;
    const repository = new DocumentQueueRepository(pool);
    const logger = createFakeLogger();
    const ingestionService = createFakeIngestionService();

    // Pre-populate database with pending items
    await repository.create({
      url: "https://example.com/test",
      sourceId: "msg-1",
      sourceContext: "channel-1",
      authorId: "author-1",
    });

    let processingStarted = false;
    const queue = new DocumentQueue({
      logger,
      ingestionService,
      repository,
      onQueueUpdate: async () => {
        processingStarted = true;
      },
    });

    await queue.initialize();

    // Wait a bit for async processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processingStarted).toBe(true);
    expect(queue.getQueueSize()).toBe(0); // Item should be processing or processed
  });

  it("returns empty array when no pending items", async () => {
    const pool = createFakePool() as unknown as Pool;
    const repository = new DocumentQueueRepository(pool);
    const logger = createFakeLogger();
    const ingestionService = createFakeIngestionService();

    const queue = new DocumentQueue({
      logger,
      ingestionService,
      repository,
    });

    const pendingItems = await queue.initialize();

    expect(pendingItems).toHaveLength(0);
  });
});

// Helper to create a fake logger
function createFakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

// Helper to create a fake ingestion service
function createFakeIngestionService(): IngestionService {
  return {
    ingestMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as IngestionService;
}

// Helper to create a fake database pool
function createFakePool() {
  const queueEntries = new Map<number, any>();
  let idCounter = 0;

  return {
    async query(sql: string, params: unknown[] = []) {
      // INSERT for document_queue
      if (sql.includes("INSERT INTO document_queue")) {
        idCounter += 1;
        const entry = {
          id: idCounter,
          url: String(params[0]),
          source_id: String(params[1]),
          source_context: String(params[2]),
          author_id: String(params[3]),
          status: "pending",
          attempts: 0,
          error_message: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          processed_at: null,
        };
        queueEntries.set(idCounter, entry);
        return { rowCount: 1, rows: [entry] };
      }

      // SELECT pending items (with status = 'pending')
      if (sql.includes("SELECT") && sql.includes("status = 'pending'") && !sql.includes("IN")) {
        const pending = Array.from(queueEntries.values()).filter(
          (e) => e.status === "pending"
        );
        return { rowCount: pending.length, rows: pending };
      }

      // SELECT pending and processing items (status IN ('pending', 'processing'))
      if (sql.includes("SELECT") && sql.includes("status IN ('pending', 'processing')") && !sql.includes("SELECT url")) {
        const pending = Array.from(queueEntries.values()).filter(
          (e) => e.status === "pending" || e.status === "processing"
        );
        return { rowCount: pending.length, rows: pending };
      }

      // UPDATE processing items to pending (resetProcessingToPending)
      if (sql.includes("UPDATE document_queue") && sql.includes("status = 'processing'")) {
        let count = 0;
        for (const entry of queueEntries.values()) {
          if (entry.status === "processing") {
            entry.status = "pending";
            entry.updated_at = new Date().toISOString();
            count++;
          }
        }
        return { rowCount: count, rows: [] };
      }

      // UPDATE status to processing
      if (sql.includes("UPDATE document_queue") && sql.includes("processing")) {
        const id = Number(params[0]);
        const entry = queueEntries.get(id);
        if (entry) {
          entry.status = "processing";
          entry.attempts += 1;
          entry.updated_at = new Date().toISOString();
        }
        return { rowCount: 1, rows: [] };
      }

      // UPDATE status to completed
      if (sql.includes("UPDATE document_queue") && sql.includes("completed")) {
        const id = Number(params[0]);
        const entry = queueEntries.get(id);
        if (entry) {
          entry.status = "completed";
          entry.processed_at = new Date().toISOString();
        }
        return { rowCount: 1, rows: [] };
      }

      // UPDATE status to failed
      if (sql.includes("UPDATE document_queue") && sql.includes("failed")) {
        const id = Number(params[0]);
        const entry = queueEntries.get(id);
        if (entry) {
          entry.status = "failed";
          entry.error_message = String(params[1]);
          entry.processed_at = new Date().toISOString();
        }
        return { rowCount: 1, rows: [] };
      }

      // SELECT all pending URLs
      if (
        sql.includes("SELECT url") &&
        sql.includes("status IN ('pending', 'processing')")
      ) {
        const pending = Array.from(queueEntries.values())
          .filter((e) => e.status === "pending" || e.status === "processing")
          .map((e) => ({ url: e.url }));
        return { rowCount: pending.length, rows: pending };
      }

      throw new Error(`Unhandled SQL in fake pool: ${sql}`);
    },
  };
}
