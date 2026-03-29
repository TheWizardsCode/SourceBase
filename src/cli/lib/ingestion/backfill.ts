import { botConfig as config } from "../../config/bot.js";
import type { LinkRecord, LinkRepository } from "../../db/repository.js";
import type { Logger } from "../../logger.js";
import type { YouTubeApiClient } from "../ingestion/youtube.js";

// Simple UUID generator for session IDs
function generateSessionId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface BackfillQueueItem {
  id: number;
  url: string;
  videoId?: string;
  contentType: "embedding" | "transcript" | "summary";
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  errorMessage?: string;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface BackfillMetrics {
  queueDepth: number;
  processedToday: number;
  failedToday: number;
  averageProcessingTime: number;
  slaViolations: number;
}

interface BackfillQueueRow {
  id: number;
  url: string;
  video_id: string | null;
  content_type: string;
  status: string;
  attempts: number;
  error_message: string | null;
  priority: number;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
}

export interface BackfillServiceOptions {
  repository: LinkRepository;
  logger: Logger;
  embedder: {
    embed(text: string): Promise<number[]>;
  };
  summarizer: {
    summarize(content: string, sessionId?: string): Promise<string>;
  };
  youtubeClient?: YouTubeApiClient;
}

export class BackfillService {
  private readonly repository: LinkRepository;
  private readonly logger: Logger;
  private readonly embedder: {
    embed(text: string): Promise<number[]>;
  };
  private readonly summarizer: {
    summarize(content: string, sessionId?: string): Promise<string>;
  };
  private readonly youtubeClient?: YouTubeApiClient;
  private isRunning = false;
  private lastMetrics: BackfillMetrics | null = null;

  constructor(options: BackfillServiceOptions) {
    this.repository = options.repository;
    this.logger = options.logger;
    this.embedder = options.embedder;
    this.summarizer = options.summarizer;
    this.youtubeClient = options.youtubeClient;
  }

  /**
   * Add an item to the backfill queue
   */
  async enqueue(
    url: string,
    contentType: "embedding" | "transcript" | "summary",
    videoId?: string,
    priority: number = 100
  ): Promise<void> {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // 24h SLA

      await this.repository["pool"].query(
        `
        INSERT INTO backfill_queue (
          url, video_id, content_type, status, attempts, priority, created_at, updated_at, expires_at
        )
        VALUES ($1, $2, $3, 'pending', 0, $4, NOW(), NOW(), $5)
        ON CONFLICT (url, content_type) DO UPDATE SET
          status = 'pending',
          attempts = 0,
          error_message = NULL,
          priority = LEAST(backfill_queue.priority, $4),
          updated_at = NOW(),
          expires_at = $5
        WHERE backfill_queue.status IN ('pending', 'failed')
        `,
        [url, videoId ?? null, contentType, priority, expiresAt]
      );

      this.logger.info("Added to backfill queue", { url, contentType, videoId });
    } catch (error) {
      this.logger.error("Failed to add to backfill queue", {
        url,
        contentType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process the backfill queue.
   * If the queue is empty, automatically seed it from links that still need
   * embeddings (links.embedding IS NULL) so the backfill bootstraps itself.
   * Should be called periodically (e.g., every hour via startPeriodicProcessing).
   */
  async processQueue(batchSize: number = 10): Promise<void> {
    if (this.isRunning) {
      this.logger.debug("Backfill queue already processing, skipping");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.info("Starting backfill queue processing", { batchSize });

      // Fetch pending items ordered by priority and creation time
      const result = await this.repository["pool"].query(
        `
        SELECT
          id, url, video_id, content_type, status, attempts,
          error_message, priority, created_at, updated_at, expires_at
        FROM backfill_queue
        WHERE status = 'pending'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY priority ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
        `,
        [batchSize]
      );

      let items = result.rows as BackfillQueueRow[];

      // If queue is empty, seed it from links that still need embeddings
      if (items.length === 0) {
        this.logger.debug("Backfill queue is empty — seeding from links without embeddings");
        const seedResult = await this.repository["pool"].query(
          `
          INSERT INTO backfill_queue (url, video_id, content_type, status, attempts, priority, created_at, updated_at, expires_at)
          SELECT DISTINCT ON (l.url)
            l.url,
            NULL,
            'embedding',
            'pending',
            0,
            100,
            NOW(),
            NOW(),
            NOW() + INTERVAL '24 hours'
          FROM links l
          WHERE l.embedding IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM backfill_queue bq
            WHERE bq.url = l.url AND bq.content_type = 'embedding' AND bq.status IN ('pending', 'processing')
          )
          ORDER BY l.url
          LIMIT $1
          RETURNING url
          `,
          [batchSize]
        );
        const seeded = seedResult.rowCount ?? 0;
        if (seeded > 0) {
          this.logger.info(`Seeded ${seeded} links into backfill queue`, { count: seeded });
        } else {
          this.logger.debug("No links without embeddings found to seed");
          this.isRunning = false;
          return;
        }

        // Re-fetch after seeding
        const reResult = await this.repository["pool"].query(
          `
          SELECT
            id, url, video_id, content_type, status, attempts,
            error_message, priority, created_at, updated_at, expires_at
          FROM backfill_queue
          WHERE status = 'pending'
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY priority ASC, created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
          `,
          [batchSize]
        );
        items = reResult.rows as BackfillQueueRow[];
      }

      if (items.length === 0) {
        this.logger.debug("No pending items in backfill queue");
        return;
      }

      this.logger.info(`Processing ${items.length} backfill items`);

      for (const row of items) {
        await this.processItem(row);
      }

      const duration = Date.now() - startTime;
      this.logger.info("Backfill queue processing completed", {
        processed: items.length,
        duration,
      });
    } catch (error) {
      this.logger.error("Error processing backfill queue", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process a single backfill item
   */
  private async processItem(row: BackfillQueueRow): Promise<void> {
    const startTime = Date.now();

    try {
      // Mark as processing
      await this.repository["pool"].query(
        `UPDATE backfill_queue SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [row.id]
      );

      // Fetch the link record
      const linkResult = await this.repository["pool"].query(
        `SELECT * FROM links WHERE url = $1`,
        [row.url]
      );

      if (linkResult.rowCount === 0) {
        throw new Error("Link record not found");
      }

      const link = linkResult.rows[0] as LinkRecord;

      // Process based on content type
      switch (row.content_type) {
        case "embedding":
          await this.processEmbeddingBackfill(link);
          break;
        case "transcript":
          await this.processTranscriptBackfill(row, link);
          break;
        case "summary":
          await this.processSummaryBackfill(link);
          break;
        default:
          throw new Error(`Unknown content type: ${row.content_type}`);
      }

      // Mark as completed
      await this.repository["pool"].query(
        `
        UPDATE backfill_queue 
        SET status = 'completed', processed_at = NOW(), updated_at = NOW() 
        WHERE id = $1
        `,
        [row.id]
      );

      this.logger.info("Backfill item completed", {
        id: row.id,
        url: row.url,
        contentType: row.content_type,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      const attempts = row.attempts + 1;
      const maxAttempts = config.MAX_BACKFILL_ATTEMPTS ?? 3;
      const status = attempts >= maxAttempts ? "failed" : "pending";

      await this.repository["pool"].query(
        `
        UPDATE backfill_queue 
        SET status = $1, attempts = $2, error_message = $3, updated_at = NOW() 
        WHERE id = $4
        `,
        [status, attempts, error instanceof Error ? error.message : String(error), row.id]
      );

      this.logger.error("Backfill item failed", {
        id: row.id,
        url: row.url,
        contentType: row.content_type,
        attempts,
        maxAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process embedding backfill
   */
  private async processEmbeddingBackfill(link: LinkRecord): Promise<void> {
    const content = [
      link.title,
      link.transcript,
      link.summary,
      link.content,
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (!content) {
      throw new Error("No content available for embedding generation");
    }

    const embedding = await this.embedder.embed(content);

    await this.repository.upsertLink({
      url: link.url,
      embedding,
    });
  }

  /**
   * Process transcript backfill
   */
  private async processTranscriptBackfill(
    row: BackfillQueueRow,
    link: LinkRecord
  ): Promise<void> {
    if (!row.video_id) {
      throw new Error("Video ID required for transcript backfill");
    }

    if (!this.youtubeClient) {
      throw new Error("YouTube client not configured");
    }

    const captionsResult = await this.youtubeClient.fetchCaptions(
      row.video_id
    );

    if (!captionsResult) {
      throw new Error("Failed to fetch captions");
    }

    await this.repository.upsertLink({
      url: link.url,
      transcript: captionsResult.transcript,
      metadata: {
        ...link.metadata,
        hasTranscript: true,
        transcriptLanguage: captionsResult.language,
        transcriptIsAutoGenerated: captionsResult.isAutoGenerated,
      },
    });

    // Trigger summary regeneration with transcript
    await this.enqueue(link.url, "summary", row.video_id, 50); // Higher priority
  }

  /**
   * Process summary backfill
   */
  private async processSummaryBackfill(link: LinkRecord): Promise<void> {
    const content = [link.title, link.transcript, link.content]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (!content) {
      throw new Error("No content available for summary generation");
    }

    // Generate unique session ID for llama.cpp context isolation
    const sessionId = generateSessionId();
    this.logger.debug("Generating summary with session", { url: link.url, sessionId });

    const summary = await this.summarizer.summarize(content, sessionId);

    await this.repository.upsertLink({
      url: link.url,
      summary,
    });
  }

  /**
   * Get current backfill metrics
   */
  async getMetrics(): Promise<BackfillMetrics> {
    try {
      const [queueResult, processedResult, failedResult, slaResult] =
        await Promise.all([
          // Queue depth
          this.repository["pool"].query(
            `SELECT COUNT(*) as count FROM backfill_queue WHERE status IN ('pending', 'processing')`
          ),
          // Processed today
          this.repository["pool"].query(
            `SELECT COUNT(*) as count FROM backfill_queue WHERE status = 'completed' AND processed_at >= NOW() - INTERVAL '24 hours'`
          ),
          // Failed today
          this.repository["pool"].query(
            `SELECT COUNT(*) as count FROM backfill_queue WHERE status = 'failed' AND updated_at >= NOW() - INTERVAL '24 hours'`
          ),
          // SLA violations
          this.repository["pool"].query(
            `SELECT COUNT(*) as count FROM backfill_queue WHERE status IN ('pending', 'processing') AND expires_at < NOW()`
          ),
        ]);

      const queueRow = queueResult.rows[0] as { count: string };
      const processedRow = processedResult.rows[0] as { count: string };
      const failedRow = failedResult.rows[0] as { count: string };
      const slaRow = slaResult.rows[0] as { count: string };

      const metrics: BackfillMetrics = {
        queueDepth: parseInt(queueRow.count, 10),
        processedToday: parseInt(processedRow.count, 10),
        failedToday: parseInt(failedRow.count, 10),
        averageProcessingTime: 0, // Would need to track this separately
        slaViolations: parseInt(slaRow.count, 10),
      };

      this.lastMetrics = metrics;
      return metrics;
    } catch (error) {
      this.logger.error("Failed to get backfill metrics", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.lastMetrics ?? {
        queueDepth: 0,
        processedToday: 0,
        failedToday: 0,
        averageProcessingTime: 0,
        slaViolations: 0,
      };
    }
  }

  /**
   * Start periodic backfill processing
   */
  startPeriodicProcessing(intervalMs: number = 60 * 60 * 1000): void {
    // Default: every hour
    this.logger.info("Starting periodic backfill processing", { intervalMs });

    // Process immediately
    void this.processQueue();

    // Then schedule periodic processing
    setInterval(() => {
      void this.processQueue();
    }, intervalMs);
  }
}
