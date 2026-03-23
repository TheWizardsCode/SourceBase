import type { Message } from "discord.js";
import { config } from "../config.js";

import type { LinkRecord } from "../db/repository.js";
import type { Logger } from "../logger.js";
import { extractAnchorHrefsFromHtml, extractCrawlSeedUrl, extractUrls, normalizeDiscoveredUrls } from "./url.js";
import type { ContentExtractor } from "./extractor.js";
import type { ExtractedContent } from "./extractor.js";
import type { CrawlPolicy } from "./crawlPolicy.js";

export interface LinkStore {
  upsertLink(link: LinkRecord): Promise<unknown>;
  enqueueEmbeddingBackfill?(input: {
    linkId: number;
    url: string;
    reason: string;
    lastError?: string;
  }): Promise<void>;
}

export interface IngestionServiceOptions {
  repository: LinkStore;
  extractor: ContentExtractor;
  summarizer: {
    summarize(content: string): Promise<string>;
  };
  embedder: {
    embed(text: string): Promise<number[]>;
    embedFull?(text: string): Promise<number[]>;
    projectToTarget?(values: number[], targetDim?: number): number[];
  };
  logger: Logger;
  successReaction: string;
  failureReaction: string;
  crawlPolicy?: CrawlPolicy;
  ann?: {
    collection: string;
    indexBatch(collection: string, items: { id: number; vector: number[] }[]): Promise<void>;
  };
}

export interface IngestionProgressUpdate {
  stage: "summarizing" | "extracting_links" | "storing" | "completed" | "failed";
  url?: string;
  current?: number;
  total?: number;
  crawl: boolean;
  succeeded?: number;
  failed?: number;
  title?: string;
  reason?: string;
}

export interface IngestionRunResult {
  totalUrls: number;
  succeeded: number;
  failed: number;
  crawl: boolean;
}

type IngestionProgressReporter = (update: IngestionProgressUpdate) => Promise<void> | void;

export class IngestionService {
  constructor(private readonly options: IngestionServiceOptions) {}

  private async reportProgress(
    reporter: IngestionProgressReporter | undefined,
    update: IngestionProgressUpdate
  ): Promise<void> {
    if (!reporter) {
      return;
    }

    try {
      await reporter(update);
    } catch (error) {
      this.options.logger.warn("Failed to report ingestion progress", {
        stage: update.stage,
        url: update.url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async extractWithPolicy(url: string): Promise<ExtractedContent | null> {
    if (!this.options.crawlPolicy) {
      return this.options.extractor.extract(url);
    }

    const allowed = await this.options.crawlPolicy.canFetch(url);
    if (!allowed) {
      this.options.logger.info("Skipping URL blocked by robots.txt", { url });
      return null;
    }

    await this.options.crawlPolicy.waitBeforeFetch(url);
    return this.options.extractor.extract(url);
  }

  private async buildIngestionPlan(
    messageText: string,
    progressReporter?: IngestionProgressReporter
  ): Promise<{ urls: string[]; prefetched: Map<string, ExtractedContent>; crawl: boolean }> {
    const uniqueUrls = new Set<string>(extractUrls(messageText));
    const prefetched = new Map<string, ExtractedContent>();

    const crawlSeed = extractCrawlSeedUrl(messageText);
    if (!crawlSeed) {
      return { urls: Array.from(uniqueUrls), prefetched, crawl: false };
    }

    uniqueUrls.add(crawlSeed);

    try {
      const seedExtracted = await this.extractWithPolicy(crawlSeed);
      if (!seedExtracted) {
        this.options.logger.warn("Crawl seed could not be extracted", { crawlSeed });
        return { urls: Array.from(uniqueUrls), prefetched, crawl: true };
      }

      prefetched.set(crawlSeed, seedExtracted);
      await this.reportProgress(progressReporter, {
        stage: "extracting_links",
        url: crawlSeed,
        crawl: true
      });
      const contentLinks = extractAnchorHrefsFromHtml(seedExtracted.content);
      const discovered = normalizeDiscoveredUrls(crawlSeed, [...(seedExtracted.links ?? []), ...contentLinks]);
      for (const discoveredUrl of discovered) {
        uniqueUrls.add(discoveredUrl);
      }

      this.options.logger.info("Discovered linked pages from crawl seed", {
        crawlSeed,
        discoveredCount: discovered.length,
        totalToProcess: uniqueUrls.size
      });
    } catch (error) {
      this.options.logger.warn("Failed to process crawl seed links", {
        crawlSeed,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return { urls: Array.from(uniqueUrls), prefetched, crawl: true };
  }

  private chunkText(text: string, maxChars: number): string[] {
    const chunks: string[] = [];
    let remaining = text.trim();
    while (remaining.length > 0) {
      if (remaining.length <= maxChars) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf(' ', maxChars);
      if (splitIdx === -1) splitIdx = maxChars;
      const part = remaining.slice(0, splitIdx).trim();
      chunks.push(part);
      remaining = remaining.slice(splitIdx).trim();
    }
    return chunks;
  }

  private averageVectors(vectors: number[][]): number[] | null {
    if (!vectors.length) return null;
    const length = vectors[0].length;
    const sum = new Array<number>(length).fill(0);
    for (const vec of vectors) {
      if (vec.length !== length) {
        this.options.logger.warn('Embedding vectors have mismatched dimensions, skipping averaging');
        return null;
      }
      for (let i = 0; i < length; i++) sum[i] += vec[i];
    }
    return sum.map(v => v / vectors.length);
  }

  async ingestMessage(
    message: Message,
    progressReporter?: IngestionProgressReporter
  ): Promise<IngestionRunResult> {
    const plan = await this.buildIngestionPlan(message.content, progressReporter);
    if (!plan.urls.length) {
      await this.reportProgress(progressReporter, {
        stage: "completed",
        crawl: plan.crawl,
        total: 0,
        succeeded: 0,
        failed: 0
      });
      return {
        totalUrls: 0,
        succeeded: 0,
        failed: 0,
        crawl: plan.crawl
      };
    }

    let succeeded = 0;
    let failed = 0;

    for (let index = 0; index < plan.urls.length; index += 1) {
      const url = plan.urls[index];
      const current = index + 1;
      const total = plan.urls.length;
      let extracted: ExtractedContent | null | undefined;
      try {
        const prefetched = plan.prefetched.get(url);
        extracted = prefetched ?? (await this.extractWithPolicy(url));
        const titleForProgress = extracted?.title ?? undefined;
        await this.reportProgress(progressReporter, {
          stage: "summarizing",
          url,
          title: titleForProgress,
          current,
          total,
          crawl: plan.crawl
        });
        this.options.logger.info("Start processing URL", { url, messageId: message.id });
        this.options.logger.debug("Extraction result", { url, title: extracted?.title, contentLength: extracted?.content?.length ?? 0 });
        if (!extracted) {
          throw new Error("No extractable article content returned");
        }

        const TOKENS_TARGET = Number(config.SUMMARIZER_MAX_TOKENS);
        const MAX_CHARS = TOKENS_TARGET * 4;
        const CHUNK_SUMMARY_CHARS = Number(config.SUMMARIZER_CHUNK_CHARS);

        const baseTextForLlm = [extracted.title, extracted.content].filter(Boolean).join("\n\n").trim();
        let summary: string | null = null;
        if (baseTextForLlm) {
          if (baseTextForLlm.length <= MAX_CHARS) {
            try {
              summary = await this.options.summarizer.summarize(baseTextForLlm);
              this.options.logger.debug("Summarization single-pass complete", { url, length: baseTextForLlm.length });
            } catch (sumErr) {
              this.options.logger.warn('Failed to summarize page in single pass', {
                url,
                messageId: message.id,
                error: sumErr instanceof Error ? sumErr.message : String(sumErr)
              });
            }
          } else {
            const chunks = this.chunkText(baseTextForLlm, CHUNK_SUMMARY_CHARS);
            this.options.logger.info("Summarization chunking (two-phase)", { url, chunks: chunks.length, originalLength: baseTextForLlm.length });
            const summaries: string[] = [];
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              this.options.logger.debug("Summarizing chunk", { url, messageId: message.id, index: i + 1, total: chunks.length, chunkLength: chunk.length });
              try {
                const part = await this.options.summarizer.summarize(chunk);
                this.options.logger.debug("Chunk summary obtained", { url, index: i + 1, summaryLength: part.length });
                summaries.push(part);
              } catch (sumErr) {
                this.options.logger.warn('Failed to summarize a chunk', {
                  url,
                  messageId: message.id,
                  index: i + 1,
                  error: sumErr instanceof Error ? sumErr.message : String(sumErr)
                });
              }
            }

            if (summaries.length) {
              const joined = summaries.join('\n\n');
              const compressPrompt = `Compress the following chunk summaries into a concise 2-3 sentence summary focused on key takeaways:\n\n${joined}`;
              try {
                const final = await this.options.summarizer.summarize(compressPrompt);
                this.options.logger.debug("Two-phase compression complete", { url, summaryLength: final.length });
                summary = final;
              } catch (compErr) {
                this.options.logger.warn('Failed to compress chunk summaries', {
                  url,
                  messageId: message.id,
                  error: compErr instanceof Error ? compErr.message : String(compErr)
                });
                summary = summaries.join(' ');
              }
            }
          }
        }

        const embeddingText = [extracted.title, summary, extracted.content]
          .filter(Boolean)
          .join("\n\n")
          .trim();
        let embedding: number[] | null = null;
        let fullEmbedding: number[] | null = null;
        if (embeddingText) {
          const MAX_EMBED_CHARS = 8000;
          const embedChunks = this.chunkText(embeddingText, MAX_EMBED_CHARS);
          this.options.logger.info("Embedding chunking", { url, batches: embedChunks.length });
          const vectors: number[][] = [];
          for (let i = 0; i < embedChunks.length; i++) {
            const chunk = embedChunks[i];
            this.options.logger.debug("Embedding batch start", { url, messageId: message.id, batch: i + 1, of: embedChunks.length, chunkLength: chunk.length });
            try {
              const vec = this.options.embedder.embedFull
                ? await this.options.embedder.embedFull(chunk)
                : await this.options.embedder.embed(chunk);
              this.options.logger.debug("Embedding batch complete", { url, batch: i + 1, vectorLength: vec.length });
              vectors.push(vec);
            } catch (embErr) {
              this.options.logger.warn('Failed to embed a chunk', {
                url,
                messageId: message.id,
                batch: i + 1,
                error: embErr instanceof Error ? embErr.message : String(embErr)
              });
            }
          }
          fullEmbedding = this.averageVectors(vectors);
          embedding = fullEmbedding ? fullEmbedding.slice() : null;
          const TARGET_EMBED_DIM = 2000;
          if (embedding) {
            if (embedding.length !== TARGET_EMBED_DIM) {
              this.options.logger.warn("Embedding dimension mismatch, resizing to DB target", {
                url,
                expected: TARGET_EMBED_DIM,
                actual: embedding.length
              });
              if (this.options.embedder.projectToTarget) {
                embedding = this.options.embedder.projectToTarget(embedding, TARGET_EMBED_DIM);
              } else if (embedding.length > TARGET_EMBED_DIM) {
                embedding = embedding.slice(0, TARGET_EMBED_DIM);
              } else {
                const padding = new Array(TARGET_EMBED_DIM - embedding.length).fill(0);
                embedding = embedding.concat(padding);
              }
            }
          }
          if (embedding) this.options.logger.debug("Embedding averaged", { url, embeddingDim: embedding.length });
        }

        await this.reportProgress(progressReporter, {
          stage: "storing",
          url,
          title: extracted.title ?? undefined,
          current,
          total,
          crawl: plan.crawl
        });

        const stored: any = await this.options.repository.upsertLink({
          url,
          title: extracted.title,
          summary,
          content: extracted.content,
          imageUrl: extracted.imageUrl,
          embedding,
          metadata: {
            ...extracted.metadata,
            discordMessageId: message.id,
            discordChannelId: message.channelId,
            discordAuthorId: message.author.id
          }
        });

        try {
          let queuedBackfill = false;
          const ann = this.options.ann;
          if (ann && stored && (stored as any).id) {
            const vectorToIndex = fullEmbedding && fullEmbedding.length ? fullEmbedding : embedding;
            if (vectorToIndex && vectorToIndex.length) {
              await ann.indexBatch(ann.collection, [{ id: (stored as any).id, vector: vectorToIndex }]);
            } else {
              this.options.logger.error("Embedding missing after ingestion; queued for backfill", {
                messageId: message.id,
                url,
                linkId: (stored as any).id,
                embeddingMissing: true,
                queueBackfill: true
              });
              if (this.options.repository.enqueueEmbeddingBackfill) {
                await this.options.repository.enqueueEmbeddingBackfill({
                  linkId: Number((stored as any).id),
                  url,
                  reason: "embedding_missing_after_ingestion",
                  lastError: "No embedding vector generated"
                });
                queuedBackfill = true;
              }
            }
          }

          if ((!fullEmbedding || fullEmbedding.length === 0) && stored && (stored as any).id && !queuedBackfill) {
            this.options.logger.error("Embedding generation unavailable; queued for backfill", {
              messageId: message.id,
              url,
              linkId: (stored as any).id,
              embeddingMissing: true,
              queueBackfill: true
            });
            if (this.options.repository.enqueueEmbeddingBackfill) {
              await this.options.repository.enqueueEmbeddingBackfill({
                linkId: Number((stored as any).id),
                url,
                reason: "embedding_generation_failed",
                lastError: "Embedding chunks all failed or returned empty"
              });
            }
          }
        } catch (annErr) {
          this.options.logger.warn("Failed to index embedding into ANN", { url, error: annErr instanceof Error ? annErr.message : String(annErr) });
        }

        this.options.logger.info('Ingested URL from message', {
          url,
          messageId: message.id
        });

        succeeded += 1;
        await message.react(this.options.successReaction);
      } catch (error) {
        await this.reportProgress(progressReporter, {
          stage: "failed",
          url,
          title: extracted?.title ?? undefined,
          reason: error instanceof Error ? error.message : String(error),
          crawl: plan.crawl
        });
        this.options.logger.warn('Failed to ingest URL', {
          url,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error)
        });

        failed += 1;
        await message.react(this.options.failureReaction);
      }
    }

    await this.reportProgress(progressReporter, {
      stage: "completed",
      crawl: plan.crawl,
      total: plan.urls.length,
      succeeded,
      failed
    });

    return {
      totalUrls: plan.urls.length,
      succeeded,
      failed,
      crawl: plan.crawl
    };
  }

}