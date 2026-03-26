import type { Message } from "discord.js";

import type { LinkRecord } from "../db/repository.js";
import type { Logger } from "../logger.js";
import { extractUrls, isYouTubeUrl, extractYouTubeVideoId, isPdfUrl, isFileUrl } from "./url.js";
import type { ContentExtractor } from "./extractor.js";
import type { YouTubeApiClient } from "./youtube.js";
import { config } from "../config.js";

export interface LinkStore {
  upsertLink(link: LinkRecord): Promise<unknown>;
  getLinkByUrl?(url: string): Promise<{ id: number; url: string } | null>;
}

export type ProgressPhase = 
  | "downloading"
  | "extracting_links"
  | "updating"
  | "summarizing"
  | "embedding"
  | "storing"
  | "completed"
  | "failed";

export interface ProgressUpdate {
  phase: ProgressPhase;
  url: string;
  current: number;
  total: number;
  message?: string;
  summary?: string;
  title?: string;
  queueSize?: number;
  isUpdate?: boolean;
  chunkCurrent?: number;
  chunkTotal?: number;
  chunkType?: "summarizing" | "embedding";
}

export interface IngestionProgress {
  urls: string[];
  completed: number;
  failed: number;
  currentUrl: string | null;
  phase: ProgressPhase;
  messageId?: string;
  queueSize?: number;
  isUpdate?: boolean;
}

export type ProgressCallback = (update: ProgressUpdate, overall: IngestionProgress, messageId?: string) => void | Promise<void>;

export interface IngestionServiceOptions {
  repository: LinkStore;
  extractor: ContentExtractor;
  pdfExtractor?: ContentExtractor;
  fileExtractor?: ContentExtractor;
  summarizer: {
    summarize(content: string, sessionId?: string): Promise<string>;
  };
  embedder: {
    embed(text: string): Promise<number[]>;
  };
  logger: Logger;
  successReaction: string;
  failureReaction: string;
  updateReaction?: string;
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

// Simple UUID generator for session IDs
function generateSessionId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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
      progressContext?: { urls: string[]; currentIndex: number; queueSize?: number }
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
        messageId: message.id,
        queueSize: progressContext?.queueSize ?? 0
      };

      // Add an "eyes" reaction to indicate the bot is processing this message
      await message.react("👀");

      // Capture the bot's user ID for later reaction removal (used later)
      const botUserId = message.client?.user?.id;

      for (let i = 0; i < allUrls.length; i++) {
        const url = allUrls[i];
        const currentIndex = baseIndex + i;
        progress.currentUrl = url;

        // Generate unique session ID for this URL (for llama.cpp context isolation)
        const sessionId = generateSessionId();

        try {
          this.options.logger.info("Start processing URL", { url, messageId: message.id, sessionId });

          // Check if URL already exists in database
          let isUpdate = false;
          if (this.options.repository.getLinkByUrl) {
            const existing = await this.options.repository.getLinkByUrl(url);
            isUpdate = !!existing;
            progress.isUpdate = isUpdate;
            if (isUpdate) {
              this.options.logger.info("URL already exists in database, will update", { url, messageId: message.id });
            }
          }

          // Report downloading phase
          await this.reportProgress(
            { phase: "downloading", url, current: currentIndex + 1, total: allUrls.length, isUpdate },
            progress
          );

          // Check if this is a YouTube URL
          if (isYouTubeUrl(url) && this.options.youtubeClient?.isConfigured()) {
            const result = await this.ingestYouTubeUrl(url, message, currentIndex + 1, allUrls.length, progress, isUpdate);
            progress.completed++;
            progress.phase = "completed";
            await this.reportProgress(
              { phase: "completed", url, current: currentIndex + 1, total: allUrls.length, summary: result.summary ?? undefined, title: result.title, isUpdate },
              progress
            );
            continue;
          }

          // Check if this is a PDF URL
          if (isPdfUrl(url) && this.options.pdfExtractor) {
            const result = await this.ingestPdfUrl(url, message, currentIndex + 1, allUrls.length, progress, isUpdate);
            progress.completed++;
            progress.phase = "completed";
            await this.reportProgress(
              { phase: "completed", url, current: currentIndex + 1, total: allUrls.length, summary: result.summary ?? undefined, title: result.title ?? undefined, isUpdate },
              progress
            );
            continue;
          }

          // Check if this is a file:// URL
          if (isFileUrl(url)) {
            // Security check: only allow file URLs from CLI or whitelisted Discord users
            const isCli = message.channelId === "cli" || (message as any).author?.id === "cli-user";
            const isWhitelisted = config.ALLOWED_FILE_URL_USERS.includes((message as any).author?.id);
            
            if (!isCli && !isWhitelisted) {
              this.options.logger.warn('Unauthorized file URL attempt', {
                url,
                userId: (message as any).author?.id,
                messageId: message.id
              });
              throw new Error("You are not authorized to submit file URLs");
            }

            const result = await this.ingestFileUrl(url, message, currentIndex + 1, allUrls.length, progress, isUpdate);
            progress.completed++;
            progress.phase = "completed";
            await this.reportProgress(
              { phase: "completed", url, current: currentIndex + 1, total: allUrls.length, summary: result.summary ?? undefined, title: result.title ?? undefined, isUpdate },
              progress
            );
            continue;
          }

          const extracted = await this.options.extractor.extract(url);
          this.options.logger.debug("Extraction result", { url, title: extracted?.title, contentLength: extracted?.content?.length ?? 0 });
          if (!extracted) {
            throw new Error("No extractable article content returned");
          }

          // Report extracting or updating phase
          progress.phase = isUpdate ? "updating" : "extracting_links";
          await this.reportProgress(
            { phase: progress.phase, url, current: currentIndex + 1, total: allUrls.length, isUpdate },
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

              // Report chunk-level progress
              progress.phase = "summarizing";
              await this.reportProgress(
                {
                  phase: "summarizing",
                  url,
                  current: currentIndex + 1,
                  total: allUrls.length,
                  isUpdate,
                  chunkCurrent: i + 1,
                  chunkTotal: chunks.length,
                  chunkType: "summarizing"
                },
                progress
              );

              try {
                const part = await this.options.summarizer.summarize(chunk, sessionId);
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

              // Report chunk-level progress
              progress.phase = "embedding";
              await this.reportProgress(
                {
                  phase: "embedding",
                  url,
                  current: currentIndex + 1,
                  total: allUrls.length,
                  isUpdate,
                  chunkCurrent: i + 1,
                  chunkTotal: embedChunks.length,
                  chunkType: "embedding"
                },
                progress
              );

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
            { phase: "completed", url, current: currentIndex + 1, total: allUrls.length, summary: summary ?? undefined, title: extracted.title ?? undefined },
            progress
          );

          // Only remove eyes and add success reaction for non-crawl or last URL
          if (!isCrawl || i === allUrls.length - 1) {
            // Remove eyes reaction before adding final success reaction
            if (botUserId) {
              const eyesReaction = message.reactions.cache.get('👀') ?? (typeof message.reactions.resolve === 'function' ? message.reactions.resolve('👀') : undefined);
              if (eyesReaction) {
                await eyesReaction.users.remove(botUserId);
              }
            }
            // Use update reaction if this is an update, otherwise use success reaction
            const reaction = isUpdate && this.options.updateReaction 
              ? this.options.updateReaction 
              : this.options.successReaction;
            await message.react(reaction);
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
          if (!isCrawl || i === allUrls.length - 1) {
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
      progress: IngestionProgress,
      isUpdate: boolean = false
    ): Promise<{ summary: string | null; title: string }> {
      const videoId = extractYouTubeVideoId(url);
      if (!videoId) {
        throw new Error("Failed to extract YouTube video ID");
      }

      // Generate unique session ID for this URL (for llama.cpp context isolation)
      const sessionId = generateSessionId();

      this.options.logger.info("Processing YouTube URL", { url, videoId, sessionId, isUpdate });

      // Report downloading phase for metadata
      await this.reportProgress(
        { phase: "downloading", url, current: currentIndex, total: totalUrls, isUpdate },
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

      // Report extracting or updating phase
      progress.phase = isUpdate ? "updating" : "extracting_links";
      await this.reportProgress(
        { phase: progress.phase, url, current: currentIndex, total: totalUrls, isUpdate },
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

      const summary = content ? await this.options.summarizer.summarize(content, sessionId) : null;

      // Generate embedding from best available content
      const embeddingText = transcript
        ? [metadata.title, transcript].filter(Boolean).join("\n\n").trim()
        : [metadata.title, summary, metadata.description].filter(Boolean).join("\n\n").trim();
      let embedding = embeddingText ? await this.options.embedder.embed(embeddingText) : null;
      
      // Resize embedding to match DB dimension
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

      // Remove eyes reaction before adding success reaction
      const botUserId = message.client?.user?.id;
      if (botUserId) {
        const eyesReaction = message.reactions.cache.get('👀') ?? (typeof message.reactions.resolve === 'function' ? message.reactions.resolve('👀') : undefined);
        if (eyesReaction) {
          await eyesReaction.users.remove(botUserId);
        }
      }
      // Use update reaction if this is an update, otherwise use success reaction
      const reaction = isUpdate && this.options.updateReaction 
        ? this.options.updateReaction 
        : this.options.successReaction;
      await message.react(reaction);
      
      return { summary, title: metadata.title };
    }

    private async ingestPdfUrl(
      url: string,
      message: Message,
      currentIndex: number,
      totalUrls: number,
      progress: IngestionProgress,
      isUpdate: boolean = false
    ): Promise<{ summary: string | null; title: string | null }> {
      // Generate unique session ID for this URL (for llama.cpp context isolation)
      const sessionId = generateSessionId();

      this.options.logger.info("Processing PDF URL", { url, sessionId, isUpdate });

      // Report downloading phase
      await this.reportProgress(
        { phase: "downloading", url, current: currentIndex, total: totalUrls, isUpdate },
        progress
      );

      // Extract PDF content using the PDF extractor
      const extracted = await this.options.pdfExtractor!.extract(url);
      if (!extracted) {
        throw new Error("Failed to extract PDF content");
      }

      // Report extracting or updating phase
      progress.phase = isUpdate ? "updating" : "extracting_links";
      await this.reportProgress(
        { phase: progress.phase, url, current: currentIndex, total: totalUrls, isUpdate },
        progress
      );

      // Generate summary from PDF content
      let summary: string | null = null;
      const contentForSummary = [extracted.title, extracted.content]
        .filter(Boolean)
        .join("\n\n")
        .trim();
      
      if (contentForSummary) {
        progress.phase = "summarizing";
        await this.reportProgress(
          {
            phase: "summarizing",
            url,
            current: currentIndex,
            total: totalUrls,
            isUpdate
          },
          progress
        );

        try {
          summary = await this.options.summarizer.summarize(contentForSummary, sessionId);
        } catch (sumErr) {
          this.options.logger.warn('Failed to summarize PDF content', {
            url,
            messageId: message.id,
            error: sumErr instanceof Error ? sumErr.message : String(sumErr)
          });
        }
      }

      // Generate embedding from PDF content
      const embeddingText = [extracted.title, summary, extracted.content]
        .filter(Boolean)
        .join("\n\n")
        .trim();
      
      let embedding: number[] | null = null;
      let fullEmbedding: number[] | null = null;
      
      if (embeddingText) {
        progress.phase = "embedding";
        await this.reportProgress(
          {
            phase: "embedding",
            url,
            current: currentIndex,
            total: totalUrls,
            isUpdate
          },
          progress
        );

        try {
          const vec = await this.options.embedder.embed(embeddingText);
          fullEmbedding = vec;
          embedding = vec.slice();
          
          // Resize embedding to match DB dimension
          const TARGET_EMBED_DIM = 2000;
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
        } catch (embErr) {
          this.options.logger.warn('Failed to embed PDF content', {
            url,
            messageId: message.id,
            error: embErr instanceof Error ? embErr.message : String(embErr)
          });
        }
      }

      // Report storing phase
      progress.phase = "storing";
      await this.reportProgress(
        { phase: "storing", url, current: currentIndex, total: totalUrls },
        progress
      );

      // Store in repository with PDF-specific metadata
      const stored = await this.options.repository.upsertLink({
        url,
        title: extracted.title,
        summary,
        content: extracted.content,
        imageUrl: extracted.imageUrl,
        embedding,
        metadata: {
          discordMessageId: message.id,
          discordChannelId: message.channelId,
          discordAuthorId: message.author.id,
          contentType: "pdf",
          pageCount: extracted.metadata.pageCount ?? null,
          pdfAuthor: extracted.metadata.author ?? null,
          pdfSubject: extracted.metadata.subject ?? null,
          pdfCreator: extracted.metadata.creator ?? null,
          pdfProducer: extracted.metadata.producer ?? null,
          pdfCreationDate: extracted.metadata.creationDate ?? null,
          pdfModificationDate: extracted.metadata.modificationDate ?? null,
          pdfVersion: extracted.metadata.pdfVersion ?? null
        }
      });

      // If an ANN provider is configured, index the original embedding
      try {
        const ann = this.options.ann;
        if (ann && stored && (stored as any).id) {
          const vectorToIndex = fullEmbedding && fullEmbedding.length ? fullEmbedding : embedding;
          if (vectorToIndex && vectorToIndex.length) {
            await ann.indexBatch(ann.collection, [{ id: (stored as any).id, vector: vectorToIndex }]);
          }
        }
      } catch (annErr) {
        this.options.logger.warn("Failed to index embedding into ANN", { url, error: annErr instanceof Error ? annErr.message : String(annErr) });
      }

      this.options.logger.info("Ingested PDF URL", {
        url,
        title: extracted.title,
        pageCount: extracted.metadata.pageCount,
        messageId: message.id
      });

      // Remove eyes reaction before adding success reaction
      const botUserId = message.client?.user?.id;
      if (botUserId) {
        const eyesReaction = message.reactions.cache.get('👀') ?? (typeof message.reactions.resolve === 'function' ? message.reactions.resolve('👀') : undefined);
        if (eyesReaction) {
          await eyesReaction.users.remove(botUserId);
        }
      }
      
      // Use update reaction if this is an update, otherwise use success reaction
      const reaction = isUpdate && this.options.updateReaction 
        ? this.options.updateReaction 
        : this.options.successReaction;
      await message.react(reaction);
      
      return { summary, title: extracted.title };
    }

    private async ingestFileUrl(
      url: string,
      message: Message,
      currentIndex: number,
      totalUrls: number,
      progress: IngestionProgress,
      isUpdate: boolean = false
    ): Promise<{ summary: string | null; title: string | null }> {
      // Generate unique session ID for this URL (for llama.cpp context isolation)
      const sessionId = generateSessionId();

      this.options.logger.info("Processing file URL", { url, sessionId, isUpdate });

      // Report downloading phase
      await this.reportProgress(
        { phase: "downloading", url, current: currentIndex, total: totalUrls, isUpdate },
        progress
      );

      // Extract file content using the file extractor
      if (!this.options.fileExtractor) {
        throw new Error("File extraction is not configured");
      }

      const extracted = await this.options.fileExtractor.extract(url);
      if (!extracted) {
        throw new Error("Failed to process file");
      }

      // Report extracting or updating phase
      progress.phase = isUpdate ? "updating" : "extracting_links";
      await this.reportProgress(
        { phase: progress.phase, url, current: currentIndex, total: totalUrls, isUpdate },
        progress
      );

      // Generate summary from file content
      let summary: string | null = null;
      const contentForSummary = [extracted.title, extracted.content]
        .filter(Boolean)
        .join("\n\n")
        .trim();
      
      if (contentForSummary) {
        progress.phase = "summarizing";
        await this.reportProgress(
          {
            phase: "summarizing",
            url,
            current: currentIndex,
            total: totalUrls,
            isUpdate
          },
          progress
        );

        try {
          summary = await this.options.summarizer.summarize(contentForSummary, sessionId);
        } catch (sumErr) {
          this.options.logger.warn('Failed to summarize file content', {
            url,
            messageId: message.id,
            error: sumErr instanceof Error ? sumErr.message : String(sumErr)
          });
        }
      }

      // Generate embedding from file content
      const embeddingText = [extracted.title, summary, extracted.content]
        .filter(Boolean)
        .join("\n\n")
        .trim();
      
      let embedding: number[] | null = null;
      let fullEmbedding: number[] | null = null;
      
      if (embeddingText) {
        progress.phase = "embedding";
        await this.reportProgress(
          {
            phase: "embedding",
            url,
            current: currentIndex,
            total: totalUrls,
            isUpdate
          },
          progress
        );

        try {
          const vec = await this.options.embedder.embed(embeddingText);
          fullEmbedding = vec;
          embedding = vec.slice();
          
          // Resize embedding to match DB dimension
          const TARGET_EMBED_DIM = 2000;
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
        } catch (embErr) {
          this.options.logger.warn('Failed to embed file content', {
            url,
            messageId: message.id,
            error: embErr instanceof Error ? embErr.message : String(embErr)
          });
        }
      }

      // Report storing phase
      progress.phase = "storing";
      await this.reportProgress(
        { phase: "storing", url, current: currentIndex, total: totalUrls },
        progress
      );

      // Store in repository with file-specific metadata
      const stored = await this.options.repository.upsertLink({
        url,
        title: extracted.title,
        summary,
        content: extracted.content,
        imageUrl: extracted.imageUrl,
        embedding,
        metadata: {
          discordMessageId: message.id,
          discordChannelId: message.channelId,
          discordAuthorId: (message as any).author?.id,
          contentType: extracted.metadata.contentType || "file",
          fileSize: extracted.metadata.fileSize ?? null,
          modifiedTime: extracted.metadata.modifiedTime ?? null,
          ...Object.fromEntries(
            Object.entries(extracted.metadata).filter(([key]) => 
              key.startsWith('pdf') || ['pageCount', 'author', 'subject', 'creator', 'producer'].includes(key)
            )
          )
        }
      });

      // If an ANN provider is configured, index the original embedding
      try {
        const ann = this.options.ann;
        if (ann && stored && (stored as any).id) {
          const vectorToIndex = fullEmbedding && fullEmbedding.length ? fullEmbedding : embedding;
          if (vectorToIndex && vectorToIndex.length) {
            await ann.indexBatch(ann.collection, [{ id: (stored as any).id, vector: vectorToIndex }]);
          }
        }
      } catch (annErr) {
        this.options.logger.warn("Failed to index embedding into ANN", { url, error: annErr instanceof Error ? annErr.message : String(annErr) });
      }

      this.options.logger.info("Ingested file URL", {
        url,
        title: extracted.title,
        messageId: message.id
      });

      // Remove eyes reaction before adding success reaction
      const botUserId = message.client?.user?.id;
      if (botUserId) {
        const eyesReaction = message.reactions.cache.get('👀') ?? (typeof message.reactions.resolve === 'function' ? message.reactions.resolve('👀') : undefined);
        if (eyesReaction) {
          await eyesReaction.users.remove(botUserId);
        }
      }
      
      // Use update reaction if this is an update, otherwise use success reaction
      const reaction = isUpdate && this.options.updateReaction 
        ? this.options.updateReaction 
        : this.options.successReaction;
      await message.react(reaction);
      
      return { summary, title: extracted.title };
    }
}
