import { config } from "../config.js";
import type { StoredLink } from "../db/repository.js";

const QDRANT_URL = config.QDRANT_URL;
const COLLECTION = config.QDRANT_COLLECTION;

export interface QdrantVectorStoreOptions {
  url?: string;
  collection?: string;
}

export class QdrantVectorStore {
  private readonly url: string;
  private readonly collection: string;

  constructor(options: QdrantVectorStoreOptions = {}) {
    this.url = options.url ?? QDRANT_URL;
    this.collection = options.collection ?? COLLECTION;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.url + path;
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    let json: T;
    try { json = JSON.parse(text) as T; } catch { json = text as unknown as T; }
    if (!res.ok) throw new Error("Qdrant " + method + " " + path + " failed (" + res.status + "): " + text);
    return json;
  }

  async ensureCollection(): Promise<void> {
    try {
      await this.request("GET", "/collections/" + this.collection);
    } catch {
      const dim = config.LLM_EMBEDDING_DIM;
      await this.request("PUT", "/collections/" + this.collection, {
        vectors: { size: dim, distance: "Cosine" },
      });
    }
  }

  async indexBatch(
    _collection: string,
    items: { id: number; vector: number[] }[],
    payload?: Record<string, unknown>[]
  ): Promise<void> {
    if (!items.length) return;
    const points = items.map((item, i) => ({
      id: String(item.id),
      vector: item.vector,
      payload: payload?.[i] ?? { id: String(item.id) },
    }));
    await this.request("PUT", "/collections/" + this.collection + "/points", { points });
  }

  async upsertPoint(
    id: number,
    vector: number[],
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.request("PUT", "/collections/" + this.collection + "/points", {
      points: [{ id: String(id), vector, payload }],
    });
  }

  async search(embedding: number[], limit = 3): Promise<StoredLink[]> {
    interface QdrantResult {
      id: number;
      score: number;
      payload: {
        id?: number;
        url?: string;
        title?: string | null;
        summary?: string | null;
        content?: string | null;
        transcript?: string | null;
        imageUrl?: string | null;
        metadata?: Record<string, unknown>;
        firstSeenAt?: string;
        lastSeenAt?: string;
        createdAt?: string;
        updatedAt?: string;
      };
    }

    const result = await this.request<{ result: QdrantResult[]; status: string }>(
      "POST",
      "/collections/" + this.collection + "/points/search",
      { vector: embedding, limit: limit }
    );

    return result.result.map((point) => ({
      id: typeof point.id === "string" ? parseInt(point.id, 10) : (point.payload.id ?? point.id),
      url: point.payload.url ?? "",
      canonicalUrl: null,
      title: point.payload.title ?? null,
      summary: point.payload.summary ?? null,
      content: point.payload.content ?? null,
      transcript: point.payload.transcript ?? null,
      imageUrl: point.payload.imageUrl ?? null,
      metadata: point.payload.metadata ?? {},
      firstSeenAt: point.payload.firstSeenAt ?? new Date().toISOString(),
      lastSeenAt: point.payload.lastSeenAt ?? new Date().toISOString(),
      createdAt: point.payload.createdAt ?? new Date().toISOString(),
      updatedAt: point.payload.updatedAt ?? new Date().toISOString(),
    }));
  }

  async deleteAll(): Promise<void> {
    try {
      await this.request("DELETE", "/collections/" + this.collection);
    } catch {
      // Collection doesn't exist, nothing to delete
    }
  }
}

let _store: QdrantVectorStore | null = null;

export function getQdrantVectorStore(): QdrantVectorStore {
  if (!_store) _store = new QdrantVectorStore();
  return _store;
}
