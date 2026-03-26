import { describe, expect, it, vi, beforeEach } from "vitest";

import { BackfillService } from "../src/ingestion/backfill.js";
import type { LinkRecord, LinkRepository } from "../src/db/repository.js";
import type { Logger } from "../src/logger.js";
import type { YouTubeApiClient } from "../src/ingestion/youtube.js";

describe("BackfillService", () => {
  let service: BackfillService;
  let mockRepository: LinkRepository;
  let mockLogger: Logger;
  let mockEmbedder: { embed: ReturnType<typeof vi.fn> };
  let mockSummarizer: { summarize: ReturnType<typeof vi.fn> };
  let mockYoutubeClient: YouTubeApiClient;
  let mockPool: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    };

    mockRepository = {
      upsertLink: vi.fn().mockResolvedValue({ id: 1 }),
      pool: mockPool as any,
    } as unknown as LinkRepository;

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    mockEmbedder = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };

    mockSummarizer = {
      summarize: vi.fn().mockResolvedValue("Generated summary"),
    };

    mockYoutubeClient = {
      fetchCaptions: vi.fn(),
    } as unknown as YouTubeApiClient;

    service = new BackfillService({
      repository: mockRepository,
      logger: mockLogger,
      embedder: mockEmbedder,
      summarizer: mockSummarizer,
      youtubeClient: mockYoutubeClient,
    });
  });

  describe("enqueue", () => {
    it("adds item to backfill queue", async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      await service.enqueue(
        "https://youtube.com/watch?v=test123",
        "embedding",
        "test123",
        50
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO backfill_queue"),
        expect.arrayContaining([
          "https://youtube.com/watch?v=test123",
          "test123",
          "embedding",
          50,
          expect.any(Date),
        ])
      );
    });
  });

  describe("processQueue", () => {
    it("processes pending items", async () => {
      const mockLink: LinkRecord = {
        url: "https://example.com/test",
        title: "Test",
        content: "Test content",
      };

      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              url: "https://example.com/test",
              video_id: null,
              content_type: "embedding",
              status: "pending",
              attempts: 0,
              error_message: null,
              priority: 100,
              created_at: new Date(),
              updated_at: new Date(),
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          ],
        })
        .mockResolvedValueOnce({ rowCount: 1 }) // Update to processing
        .mockResolvedValueOnce({
          rows: [{ ...mockLink, transcript: null }],
          rowCount: 1,
        }) // Fetch link
        .mockResolvedValueOnce({ rowCount: 1 }) // Update to completed
        .mockResolvedValueOnce({ rows: [{ count: "0" }] }); // Metrics

      await service.processQueue(1);

      expect(mockEmbedder.embed).toHaveBeenCalled();
      expect(mockRepository.upsertLink).toHaveBeenCalled();
    });

    it("handles empty queue gracefully", async () => {
      // First: empty backfill_queue SELECT
      // Second: seed INSERT/SELECT from links → 0 rows (no links without embeddings in mock)
      // Third: re-fetch backfill_queue after seeding → 0 rows
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] });

      await service.processQueue();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Backfill queue is empty — seeding from links without embeddings"
      );
    });

    it("retries failed items up to max attempts", async () => {
      const maxAttempts = 3;

      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              url: "https://example.com/test",
              video_id: null,
              content_type: "embedding",
              status: "pending",
              attempts: maxAttempts - 1,
              error_message: "Previous error",
              priority: 100,
              created_at: new Date(),
              updated_at: new Date(),
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          ],
        })
        .mockResolvedValueOnce({ rowCount: 1 }) // Update to processing
        .mockResolvedValueOnce({
          rows: [{ url: "https://example.com/test" }],
          rowCount: 1,
        }) // Fetch link
        .mockResolvedValueOnce({ rowCount: 1 }); // Update to failed

      // Make embedder fail
      mockEmbedder.embed.mockRejectedValue(new Error("Embedding failed"));

      await service.processQueue(1);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE backfill_queue"),
        expect.arrayContaining(["failed", maxAttempts])
      );
    });
  });

  describe("getMetrics", () => {
    it("returns current queue metrics", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ count: "5" }] }) // queue depth
        .mockResolvedValueOnce({ rows: [{ count: "10" }] }) // processed today
        .mockResolvedValueOnce({ rows: [{ count: "2" }] }) // failed today
        .mockResolvedValueOnce({ rows: [{ count: "1" }] }); // SLA violations

      const metrics = await service.getMetrics();

      expect(metrics.queueDepth).toBe(5);
      expect(metrics.processedToday).toBe(10);
      expect(metrics.failedToday).toBe(2);
      expect(metrics.slaViolations).toBe(1);
    });
  });

  describe("processEmbeddingBackfill", () => {
    it("generates embedding from available content", async () => {
      const link: LinkRecord = {
        url: "https://example.com/test",
        title: "Test Title",
        transcript: "Test transcript",
        summary: "Test summary",
        content: "Test content",
      };

      mockPool.query
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [link],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      // Access private method via any
      await (service as any).processEmbeddingBackfill(link);

      expect(mockEmbedder.embed).toHaveBeenCalledWith(
        expect.stringContaining("Test Title")
      );
      expect(mockRepository.upsertLink).toHaveBeenCalledWith({
        url: link.url,
        embedding: [0.1, 0.2, 0.3],
      });
    });
  });

  describe("processTranscriptBackfill", () => {
    it("fetches and stores transcript", async () => {
      const link: LinkRecord = {
        url: "https://youtube.com/watch?v=test123",
        title: "Test Video",
      };

      mockPool.query
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ url: link.url }] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 });

      mockYoutubeClient.fetchCaptions = vi.fn().mockResolvedValue({
        transcript: "Test transcript content",
        language: "en",
        isAutoGenerated: false,
      });

      await (service as any).processTranscriptBackfill(
        {
          id: 1,
          url: link.url,
          video_id: "test123",
          content_type: "transcript",
          status: "pending",
          attempts: 0,
          priority: 100,
          created_at: new Date(),
          updated_at: new Date(),
        },
        link
      );

      expect(mockYoutubeClient.fetchCaptions).toHaveBeenCalledWith("test123");
      expect(mockRepository.upsertLink).toHaveBeenCalledWith(
        expect.objectContaining({
          transcript: "Test transcript content",
        })
      );
    });
  });

  describe("processSummaryBackfill", () => {
    it("generates summary from transcript and content", async () => {
      const link: LinkRecord = {
        url: "https://example.com/test",
        title: "Test Title",
        transcript: "Test transcript",
        content: "Test content",
      };

      mockPool.query
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ url: link.url }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await (service as any).processSummaryBackfill(link);

      expect(mockSummarizer.summarize).toHaveBeenCalledWith(
        expect.stringContaining("Test Title"),
        expect.any(String)
      );
      expect(mockRepository.upsertLink).toHaveBeenCalledWith({
        url: link.url,
        summary: "Generated summary",
      });
    });
  });
});
