export interface LinkRecord {
  url: string;
  canonicalUrl?: string | null;
  title?: string | null;
  summary?: string | null;
  content?: string | null;
  transcript?: string | null;
  imageUrl?: string | null;
  metadata?: Record<string, unknown>;
  embedding?: number[] | null;
}

export interface DatabaseStats {
  totalLinks: number;
  linksWithEmbeddings: number;
  linksWithSummaries: number;
  linksWithTranscripts: number;
  linksWithContent: number;
  linksLast24Hours: number;
  linksLast7Days: number;
  linksLast30Days: number;
  averageEmbeddingDimensions: number;
}

export interface StoredLink {
  id: number;
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  summary: string | null;
  content: string | null;
  transcript: string | null;
  imageUrl: string | null;
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult extends StoredLink {
  similarity: number;
}

export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }>;
}

export class LinkRepository {
  constructor(private readonly pool: Queryable) {}

  async upsertLink(link: LinkRecord): Promise<StoredLink> {
    const embeddingLiteral = link.embedding ? toVectorLiteral(link.embedding) : null;
    const result = await this.pool.query(
      `
      INSERT INTO links (
        url,
        canonical_url,
        title,
        summary,
        content,
        transcript,
        image_url,
        metadata,
        embedding,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::vector, now(), now(), now(), now())
      ON CONFLICT (url)
      DO UPDATE SET
        canonical_url = EXCLUDED.canonical_url,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        content = EXCLUDED.content,
        transcript = COALESCE(EXCLUDED.transcript, links.transcript),
        image_url = EXCLUDED.image_url,
        metadata = EXCLUDED.metadata,
        embedding = COALESCE(EXCLUDED.embedding, links.embedding),
        last_seen_at = now(),
        updated_at = now()
      RETURNING
        id,
        url,
        canonical_url,
        title,
        summary,
        content,
        transcript,
        image_url,
        metadata,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      `,
      [
        link.url,
        link.canonicalUrl ?? null,
        link.title ?? null,
        link.summary ?? null,
        link.content ?? null,
        link.transcript ?? null,
        link.imageUrl ?? null,
        JSON.stringify(link.metadata ?? {}),
        embeddingLiteral
      ]
    );

    const row = result.rows[0] as StoredLinkRow;
    return mapStoredLink(row);
  }

  async getLinkByUrl(url: string): Promise<StoredLink | null> {
    const result = await this.pool.query(
      `
      SELECT
        id,
        url,
        canonical_url,
        title,
        summary,
        content,
        image_url,
        metadata,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      FROM links
      WHERE url = $1
      `,
      [url]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapStoredLink(result.rows[0] as StoredLinkRow);
  }

  async saveCheckpoint(channelId: string, lastProcessedMessageId: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO app_checkpoints (channel_id, last_processed_message_id, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (channel_id)
      DO UPDATE SET
        last_processed_message_id = EXCLUDED.last_processed_message_id,
        updated_at = now()
      `,
      [channelId, lastProcessedMessageId]
    );
  }

  async getCheckpoint(channelId: string): Promise<string | null> {
    const result = await this.pool.query(
      "SELECT last_processed_message_id FROM app_checkpoints WHERE channel_id = $1",
      [channelId]
    );

    if (!result.rowCount) {
      return null;
    }

    const row = result.rows[0] as { last_processed_message_id: string };
    return row.last_processed_message_id;
  }

  async searchSimilarLinks(embedding: number[], limit = 3): Promise<StoredLink[]> {
    const result = await this.pool.query(
      `
      SELECT
        id,
        url,
        canonical_url,
        title,
        summary,
        content,
        image_url,
        metadata,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      FROM links
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2
      `,
      [toVectorLiteral(embedding), limit]
    );

    return result.rows.map((row) => mapStoredLink(row as StoredLinkRow));
  }

  async searchSimilarLinksWithScores(embedding: number[], limit = 3): Promise<SearchResult[]> {
    const result = await this.pool.query(
      `
      SELECT
        id,
        url,
        canonical_url,
        title,
        summary,
        content,
        image_url,
        metadata,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at,
        embedding <=> $1::vector as distance
      FROM links
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2
      `,
      [toVectorLiteral(embedding), limit]
    );

    return result.rows.map((row) => {
      const typedRow = row as StoredLinkRow & { distance: string };
      return {
        ...mapStoredLink(typedRow),
        similarity: 1 - parseFloat(typedRow.distance) // Convert distance to similarity (0-1)
      };
    });
  }

  async getStats(): Promise<DatabaseStats> {
    const result = await this.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM links) as total_links,
        (SELECT COUNT(*) FROM links WHERE embedding IS NOT NULL) as links_with_embeddings,
        (SELECT COUNT(*) FROM links WHERE summary IS NOT NULL) as links_with_summaries,
        (SELECT COUNT(*) FROM links WHERE transcript IS NOT NULL) as links_with_transcripts,
        (SELECT COUNT(*) FROM links WHERE content IS NOT NULL) as links_with_content,
        (SELECT COUNT(*) FROM links WHERE created_at > NOW() - INTERVAL '24 hours') as links_last_24h,
        (SELECT COUNT(*) FROM links WHERE created_at > NOW() - INTERVAL '7 days') as links_last_7d,
        (SELECT COUNT(*) FROM links WHERE created_at > NOW() - INTERVAL '30 days') as links_last_30d,
        -- Some Postgres setups (pgvector) don't expose the embedding as a
        -- regular SQL array which makes array_length() fail. Returning 0
        -- here is safe and avoids making the stats query fragile. If you
        -- need a real average embedding dimension, compute it offline or
        -- implement a DB-side function that extracts the vector length.
        0 as avg_embedding_dim
    `);

    const row = result.rows[0] as Record<string, string>;
    return {
      totalLinks: parseInt(row.total_links),
      linksWithEmbeddings: parseInt(row.links_with_embeddings),
      linksWithSummaries: parseInt(row.links_with_summaries),
      linksWithTranscripts: parseInt(row.links_with_transcripts),
      linksWithContent: parseInt(row.links_with_content),
      linksLast24Hours: parseInt(row.links_last_24h),
      linksLast7Days: parseInt(row.links_last_7d),
      linksLast30Days: parseInt(row.links_last_30d),
      averageEmbeddingDimensions: parseFloat(row.avg_embedding_dim),
    };
  }
}

interface StoredLinkRow {
  id: number;
  url: string;
  canonical_url: string | null;
  title: string | null;
  summary: string | null;
  content: string | null;
  transcript: string | null;
  image_url: string | null;
  metadata: Record<string, unknown>;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapStoredLink(row: StoredLinkRow): StoredLink {
  return {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    summary: row.summary,
    content: row.content,
    transcript: row.transcript,
    imageUrl: row.image_url,
    metadata: row.metadata,
    firstSeenAt: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : String(row.first_seen_at),
    lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : String(row.last_seen_at),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
