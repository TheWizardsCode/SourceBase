import { describe, expect, it } from "vitest";

import type { Queryable } from "../src/db/repository.js";
import { LinkRepository } from "../src/db/repository.js";

describe("LinkRepository", () => {
  it("inserts new links and returns stored row", async () => {
    const pool = createFakePool();
    const repository = new LinkRepository(pool);

    const stored = await repository.upsertLink({
      url: "https://example.com/a",
      title: "Example",
      metadata: { source: "test" },
      embedding: [0.1, 0.2]
    });

    expect(stored.id).toBe(1);
    expect(stored.url).toBe("https://example.com/a");
    expect(stored.title).toBe("Example");
    expect(stored.metadata).toEqual({ source: "test" });
  });

  it("upserts duplicate links without creating a second row", async () => {
    const pool = createFakePool();
    const repository = new LinkRepository(pool);

    await repository.upsertLink({
      url: "https://example.com/a",
      title: "Old title",
      metadata: { version: 1 }
    });

    const updated = await repository.upsertLink({
      url: "https://example.com/a",
      title: "New title",
      metadata: { version: 2 }
    });

    expect(updated.id).toBe(1);
    expect(updated.title).toBe("New title");
    expect(updated.metadata).toEqual({ version: 2 });

    const lookup = await repository.getLinkByUrl("https://example.com/a");
    expect(lookup?.id).toBe(1);
    expect(lookup?.title).toBe("New title");
  });

  it("saves and loads per-channel checkpoints", async () => {
    const pool = createFakePool();
    const repository = new LinkRepository(pool);

    expect(await repository.getCheckpoint("123")).toBeNull();

    await repository.saveCheckpoint("123", "987");
    expect(await repository.getCheckpoint("123")).toBe("987");

    await repository.saveCheckpoint("123", "999");
    expect(await repository.getCheckpoint("123")).toBe("999");
  });

  it("searches links by semantic distance order", async () => {
    const pool = createFakePool();
    const repository = new LinkRepository(pool);

    await repository.upsertLink({
      url: "https://example.com/close",
      title: "Close",
      summary: "Closest match",
      embedding: [0.9, 0.1, 0]
    });

    await repository.upsertLink({
      url: "https://example.com/far",
      title: "Far",
      summary: "Far match",
      embedding: [0, 1, 0]
    });

    const results = await repository.searchSimilarLinks([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe("https://example.com/close");
    expect(results[1].url).toBe("https://example.com/far");
  });
});

type LinkRow = {
  id: number;
  url: string;
  canonical_url: string | null;
  title: string | null;
  summary: string | null;
  content: string | null;
  image_url: string | null;
  metadata: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  embedding: string | null;
};

function createFakePool(): Queryable {
  const links = new Map<string, LinkRow>();
  const checkpoints = new Map<string, string>();
  let id = 0;

  return {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("INSERT INTO links")) {
        const url = String(params[0]);
        const now = new Date().toISOString();
        const existing = links.get(url);

        if (existing) {
          const updated: LinkRow = {
            ...existing,
            canonical_url: (params[1] as string | null) ?? null,
            title: (params[2] as string | null) ?? null,
            summary: (params[3] as string | null) ?? null,
            content: (params[4] as string | null) ?? null,
            image_url: (params[5] as string | null) ?? null,
            metadata: JSON.parse(String(params[6])) as Record<string, unknown>,
            embedding: (params[7] as string | null) ?? existing.embedding,
            last_seen_at: now,
            updated_at: now
          };
          links.set(url, updated);
          return { rowCount: 1, rows: [updated] };
        }

        id += 1;
        const inserted: LinkRow = {
          id,
          url,
          canonical_url: (params[1] as string | null) ?? null,
          title: (params[2] as string | null) ?? null,
          summary: (params[3] as string | null) ?? null,
          content: (params[4] as string | null) ?? null,
          image_url: (params[5] as string | null) ?? null,
          metadata: JSON.parse(String(params[6])) as Record<string, unknown>,
          embedding: (params[7] as string | null) ?? null,
          first_seen_at: now,
          last_seen_at: now,
          created_at: now,
          updated_at: now
        };

        links.set(url, inserted);
        return { rowCount: 1, rows: [inserted] };
      }

      if (sql.includes("FROM links") && sql.includes("WHERE url = $1")) {
        const row = links.get(String(params[0]));
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }

      if (sql.includes("INSERT INTO app_checkpoints")) {
        checkpoints.set(String(params[0]), String(params[1]));
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("FROM app_checkpoints")) {
        const value = checkpoints.get(String(params[0]));
        return {
          rowCount: value ? 1 : 0,
          rows: value ? [{ last_processed_message_id: value }] : []
        };
      }

      if (sql.includes("ORDER BY embedding <=>")) {
        const queryEmbedding = parseVector(String(params[0]));
        const limit = Number(params[1]);

        const withEmbeddings = Array.from(links.values())
          .filter((row) => Boolean(row.embedding))
          .sort((a, b) => {
            const distA = cosineDistance(queryEmbedding, parseVector(String(a.embedding)));
            const distB = cosineDistance(queryEmbedding, parseVector(String(b.embedding)));
            return distA - distB;
          })
          .slice(0, limit);

        return { rowCount: withEmbeddings.length, rows: withEmbeddings };
      }

      throw new Error(`Unhandled SQL in fake pool: ${sql}`);
    }
  };
}

function parseVector(value: string): number[] {
  return value
    .replace("[", "")
    .replace("]", "")
    .split(",")
    .filter((item) => item.length > 0)
    .map((item) => Number(item));
}

function cosineDistance(a: number[], b: number[]): number {
  const dot = a.reduce((sum, current, index) => sum + current * (b[index] ?? 0), 0);
  const aNorm = Math.sqrt(a.reduce((sum, current) => sum + current * current, 0));
  const bNorm = Math.sqrt(b.reduce((sum, current) => sum + current * current, 0));
  if (!aNorm || !bNorm) {
    return 1;
  }

  return 1 - dot / (aNorm * bNorm);
}
