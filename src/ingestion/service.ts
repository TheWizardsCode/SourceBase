import type { Message } from "discord.js";

import type { LinkRecord } from "../db/repository.js";
import type { Logger } from "../logger.js";
import { extractUrls, isYouTubeUrl, extractYouTubeVideoId } from "./url.js";
import type { ContentExtractor } from "./extractor.js";
import type { YouTubeApiClient } from "./youtube.js";

export interface LinkStore {
  upsertLink(link: LinkRecord): Promise<unknown>;
}

export type ProgressPhase = 
  | "downloading"
  | "extracting_links" 
  | "storing"
  | "completed"
  | "failed";

export interface ProgressUpdate {
  phase: ProgressPhase;
  url: string;
  current: number;
  total: number;
  message?: string;
}

export interface IngestionProgress {
  urls: string[];
  completed: number;
  failed: number;
  currentUrl: string | null;
  phase: ProgressPhase;
  messageId?: string;
}

export type ProgressCallback = (update: ProgressUpdate, overall: IngestionProgress, messageId?: string) => void | Promise<void>;

export interface IngestionServiceOptions {
  repository: LinkStore;
  extractor: ContentExtractor;
  summarizer: {
    summarize(content: string): Promise<string>;
  };
  embedder: {
    embed(text: string): Promise<number[]>;
  };
  logger: Logger;
  successReaction: string;
  failureReaction: string;
  youtubeClient?: YouTubeApiClient;
  // Optional ANN indexer (e.g. Milvus). If present, ingestion will index
  // the original (pre-resize) embedding into the ANN service using the
  // returned DB id as the ANN primary key.
  ann?: {
    collection: string;
    indexBatch(collection: string, items: { id: number; vector: number[] }[]): Promise<void>;
  };
  // Optional progress callback for real-time status updates
  onProgress?: ProgressCallback;
}

export class IngestionService {
  constructor(private readonly options: IngestionServiceOptions) {}

    /**
     * Split a long string into smaller chunks that fit within the LLM token limits.
     * We approximate token count by characters (≈4 characters per token) and cut on
     * whitespace boundaries so we don’t split words in half.
     */
    private chunkText(text: string, maxChars: number): string[] {
      const chunks: string[] = [];
      let remaining = text.trim();
      while (remaining.length > 0) {
        if (remaining.length <= maxChars) {
          chunks.push(remaining);
          break;
        }
        // Find a split point near maxChars that is a whitespace
        let splitIdx = remaining.lastIndexOf(' ', maxChars);
        // If no whitespace (very long word), split forcibly at maxChars
        if (splitIdx === -1) splitIdx = maxChars;
        const part = remaining.slice(0, splitIdx).trim();
        chunks.push(part);
        remaining = remaining.slice(splitIdx).trim();
      }
      return chunks;
    }

    /**
     * Average a list of same‑length numeric vectors into a single vector.
     */
    private averageVectors(vectors: number[][]): number[] | null {
      if (!vectors.length) return null;
      const length = vectors[0].length;
      const sum = new Array<number>(length).fill(0);
      for (const vec of vectors) {
        if (vec.length !== length) {
          // Inconsistent dimensions – log and abort averaging for safety
          this.options.logger.warn('Embedding vectors have mismatched dimensions, skipping averaging');
          return null;
        }
        for (let i = 0; i < length; i++) sum[i] += vec[i];
      }
      return sum.map(v => v / vectors.length);
    }

    private async reportProgress(
      update: ProgressUpdate,
      overall: IngestionProgress
    ): Promise<void> {
      if (this.options.onProgress) {
        try {
          await this.options.onProgress(update, overall, overall.messageId);
        } catch (err) {
          this.options.logger.warn("Progress callback failed", {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    async ingestMessage(
      message: Message,
      progressContext?: { urls: string[]; currentIndex: number }
    ): Promise<void> {
      const urls = extractUrls(message.content);
      if (!urls.length) {
        return;
      }

      const isCrawl = !!progressContext;
      const allUrls = progressContext?.urls ?? urls;
      const baseIndex = progressContext?.currentIndex ?? 0;

      // Initialize progress tracking with message ID
      const progress: IngestionProgress = {
        urls: allUrls,
        completed: 0,
        failed: 0,
        currentUrl: null,
        phase: "downloading",
        messageId: message.id
      };

      // Add an "eyes" reaction to indicate the bot is processing this message
      await message.react("👀");

      // Capture the bot's user ID for later reaction removal (used later)
      const botUserId = message.client?.user?.id;

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const currentIndex = baseIndex + i;
        progress.currentUrl = url;

        try {
          this.options.logger.info("Start processing URL", { url, messageId: message.id });

          // Report downloading phase
          await this.reportProgress(
            { phase: "downloading", url, current: currentIndex + 1, total: allUrls.length },
            progress
          );

          // Check if this is a YouTube URL
          if (isYouTubeUrl(url) && this.options.youtubeClient?.isConfigured()) {
            await this.ingestYouTubeUrl(url, message, currentIndex + 1, allUrls.length, progress);
            progress.completed++;
            progress.phase = "completed";
            await this.reportProgress(
              { phase: "completed", url, current: currentIndex + 1, total: allUrls.length },
              progress
            );
            continue;
          }

          const extracted = await this.options.extractor.extract(url);
          this.options.logger.debug("Extraction result", { url, title: extracted?.title, contentLength: extracted?.content?.length ?? 0 });
          if (!extracted) {
            throw new Error("No extractable article content returned");
          }

          // Report extracting phase
          progress.phase = "extracting_links";
          await this.reportProgress(
            { phase: "extracting_links", url, current: currentIndex + 1, total: allUrls.length },
            progress
          );

          // ----- Summarisation (with chunking) -----
          const baseTextForLlm = [extracted.title, extracted.content]
            .filter(Boolean)
            .join("\n\n")
            .trim();
          let summary: string | null = null;
          if (baseTextForLlm) {
            // Approximate safe character limit per request (≈2000 tokens => 8000 chars)
            const MAX_CHARS = 8000;
            const chunks = this.chunkText(baseTextForLlm, MAX_CHARS);
            this.options.logger.info("Summarization chunking", { url, chunks: chunks.length });
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
                // Continue with remaining chunks; we still produce a partial summary
              }
            }
            if (summaries.length) {
              // Join the chunk summaries; optionally a second pass could compress further
              summary = summaries.join(' ');
            }
          }

          // ----- Embedding (with chunking) -----
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
                const vec = await this.options.embedder.embed(chunk);
                this.options.logger.debug("Embedding batch complete", { url, batch: i + 1, vectorLength: vec.length });
                vectors.push(vec);
              } catch (embErr) {
                this.options.logger.warn('Failed to embed a chunk', {
                  url,
                  messageId: message.id,
                  batch: i + 1,
                  error: embErr instanceof Error ? embErr.message : String(embErr)
                });
                // Continue; we may still have some vectors to average
              }
            }
            // Capture the full averaged embedding prior to any DB resizing
            fullEmbedding = this.averageVectors(vectors);
            embedding = fullEmbedding ? fullEmbedding.slice() : null;
            // Ensure embedding matches DB dimension (migration expects 1536).
            // If the model returns a different dimension, resize conservatively
            // by truncating or padding with zeros. This avoids DB insertion
            // errors while preserving most of the vector information.
            const TARGET_EMBED_DIM = 2000;
            if (embedding) {
              if (embedding.length !== TARGET_EMBED_DIM) {
                this.options.logger.warn("Embedding dimension mismatch, resizing to DB target", {
                  url,
                  expected: TARGET_EMBED_DIM,
                  actual: embedding.length
                });
                if (embedding.length > TARGET_EMBED_DIM) {
                  embedding = embedding.slice(0, TARGET_EMBED_DIM);
                } else {
                  const padding = new Array(TARGET_EMBED_DIM - embedding.length).fill(0);
                  embedding = embedding.concat(padding);
                }
              }
            }
            if (embedding) this.options.logger.debug("Embedding averaged", { url, embeddingDim: embedding.length });
          }

          // Report storing phase
          progress.phase = "storing";
          await this.reportProgress(
            { phase: "storing", url, current: currentIndex + 1, total: allUrls.length },
            progress
          );

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

          // If an ANN provider is configured, index the original embedding
          // before any DB-side projection/truncation. We captured the
          // `embedding` variable earlier which may have been resized for DB;
          // to preserve best fidelity we try to index the averaged vectors
          // from `vectors` if available. The repo.upsertLink returned object
          // should include the assigned `id` we use as the ANN primary key.
          try {
            const ann = this.options.ann;
            if (ann && stored && (stored as any).id) {
              // Prefer indexing the full pre-resize averaged vector (if available).
              const vectorToIndex = fullEmbedding && fullEmbedding.length ? fullEmbedding : embedding;
              if (vectorToIndex && vectorToIndex.length) {
                await ann.indexBatch(ann.collection, [{ id: (stored as any).id, vector: vectorToIndex }]);
              }
            }
          } catch (annErr) {
            this.options.logger.warn("Failed to index embedding into ANN", { url, error: annErr instanceof Error ? annErr.message : String(annErr) });
          }

          this.options.logger.info('Ingested URL from message', {
            url,
            messageId: message.id
          });

          progress.completed++;
          progress.phase = "completed";
          await this.reportProgress(
            { phase: "completed", url, current: currentIndex + 1, total: allUrls.length },
            progress
          );

          // Only remove eyes and add success reaction for non-crawl or last URL
          if (!isCrawl || i === urls.length - 1) {
            // Remove eyes reaction before adding final success reaction
            if (botUserId) {
              const eyesReaction = message.reactions.cache.get('👀') ?? (typeof message.reactions.resolve === 'function' ? message.reactions.resolve('👀') : undefined);
              if (eyesReaction) {
                await eyesReaction.users.remove(botUserId);
              }
            }
            await message.react(this.options.successReaction);
          }
        } catch (error) {
          this.options.logger.warn('Failed to ingest URL', {
            url,
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error)
          });

          progress.failed++;
          progress.phase = "failed";
          await this.reportProgress(
            { phase: "failed", url, current: currentIndex + 1, total: allUrls.length, message: error instanceof Error ? error.message : String(error) },
            progress
          );

          // Only remove eyes and add failure reaction for non-crawl or last URL
          if (!isCrawl || i === urls.length - 1) {
            // Remove eyes reaction before adding failure reaction
            if (botUserId) {
              const eyesReaction = message.reactions.cache.get('👀') ?? (typeof message.reactions.resolve === 'function' ? message.reactions.resolve('👀') : undefined);
              if (eyesReaction) {
                await eyesReaction.users.remove(botUserId);
              }
            }
            await message.react(this.options.failureReaction);
          }
        }
      }
    }

    private async ingestYouTubeUrl(
      url: string,
      message: Message,
      currentIndex: number,
      totalUrls: number,
      progress: IngestionProgress
    ): Promise<void> {
      const videoId = extractYouTubeVideoId(url);
      if (!videoId) {
        throw new Error("Failed to extract YouTube video ID");
      }

      this.options.logger.info("Processing YouTube URL", { url, videoId });

      // Report downloading phase for metadata
      await this.reportProgress(
        { phase: "downloading", url, current: currentIndex, total: totalUrls },
        progress
      );

      // Fetch metadata from YouTube API
      const metadata = await this.options.youtubeClient!.fetchVideoMetadata(videoId);
      if (!metadata) {
        throw new Error("Failed to fetch YouTube metadata");
      }

      // Fetch captions if available
      const captionsResult = await this.options.youtubeClient!.fetchCaptions(videoId);
      const transcript = captionsResult?.transcript ?? null;

      // Report extracting phase
      progress.phase = "extracting_links";
      await this.reportProgress(
        { phase: "extracting_links", url, current: currentIndex, total: totalUrls },
        progress
      );

      // Generate summary using transcript if available, otherwise use metadata
      let content: string;
      if (transcript) {
        content = [metadata.title, transcript].filter(Boolean).join("\n\n").trim();
        this.options.logger.info("Using transcript for YouTube summary", {
          url,
          videoId,
          transcriptLength: transcript.length,
          language: captionsResult?.language
        });
      } else {
        content = [metadata.title, metadata.description].filter(Boolean).join("\n\n").trim();
      }

      const summary = content ? await this.options.summarizer.summarize(content) : null;

      // Generate embedding from best available content
      const embeddingText = transcript
        ? [metadata.title, transcript].filter(Boolean).join("\n\n").trim()
        : [metadata.title, summary, metadata.description].filter(Boolean).join("\n\n").trim();
      const embedding = embeddingText ? await this.options.embedder.embed(embeddingText) : null;

      // Report storing phase
      progress.phase = "storing";
      await this.reportProgress(
        { phase: "storing", url, current: currentIndex, total: totalUrls },
        progress
      );

      await this.options.repository.upsertLink({
        url,
        title: metadata.title,
        summary,
        content: metadata.description,
        transcript,
        imageUrl: metadata.thumbnailUrl,
        embedding,
        metadata: {
          discordMessageId: message.id,
          discordChannelId: message.channelId,
          discordAuthorId: message.author.id,
          contentType: "youtube",
          videoId: metadata.videoId,
          channelTitle: metadata.channelTitle,
          publishedAt: metadata.publishedAt,
          hasTranscript: !!transcript,
          transcriptLanguage: captionsResult?.language ?? null,
          transcriptIsAutoGenerated: captionsResult?.isAutoGenerated ?? null
        }
      });

      this.options.logger.info("Ingested YouTube URL", {
        url,
        videoId,
        title: metadata.title,
        messageId: message.id
      });

      await message.react(this.options.successReaction);
    }

}
