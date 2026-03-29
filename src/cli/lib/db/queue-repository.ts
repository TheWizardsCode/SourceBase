import type { Pool } from "pg";

export interface QueueEntry {
  id: number;
  url: string;
  sourceId: string;
  sourceContext: string;
  authorId: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date;
}

export interface CreateQueueEntry {
  url: string;
  sourceId: string;
  sourceContext: string;
  authorId: string;
}

export class DocumentQueueRepository {
  constructor(private readonly pool: Pool) {}

  async create(entry: CreateQueueEntry): Promise<QueueEntry> {
    const result = await this.pool.query(
      `INSERT INTO document_queue (url, source_id, source_context, author_id, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [entry.url, entry.sourceId, entry.sourceContext, entry.authorId]
    );
    return this.mapRow(result.rows[0]);
  }

  async getPending(): Promise<QueueEntry[]> {
    const result = await this.pool.query(
      `SELECT * FROM document_queue 
       WHERE status IN ('pending', 'processing')
       ORDER BY created_at ASC`
    );
    return result.rows.map(row => this.mapRow(row));
  }

  async markProcessing(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE document_queue 
       SET status = 'processing', attempts = attempts + 1
       WHERE id = $1`,
      [id]
    );
  }

  async markCompleted(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE document_queue 
       SET status = 'completed', processed_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  async markFailed(id: number, errorMessage: string): Promise<void> {
    await this.pool.query(
      `UPDATE document_queue 
       SET status = 'failed', error_message = $2, processed_at = NOW()
       WHERE id = $1`,
      [id, errorMessage]
    );
  }

  async delete(id: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM document_queue WHERE id = $1`,
      [id]
    );
  }

  async getByUrl(url: string): Promise<QueueEntry | null> {
    const result = await this.pool.query(
      `SELECT * FROM document_queue WHERE url = $1 AND status IN ('pending', 'processing')`,
      [url]
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async getAllPendingUrls(): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT url FROM document_queue WHERE status IN ('pending', 'processing')`
    );
    return result.rows.map(row => row.url);
  }

  async getPendingCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM document_queue WHERE status IN ('pending', 'processing')`
    );
    return result.rows.length > 0 ? Number(result.rows[0].count) : 0;
  }

  async resetProcessingToPending(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE document_queue 
       SET status = 'pending', updated_at = NOW()
       WHERE status = 'processing'
       RETURNING id`
    );
    return result.rows.length;
  }

  private mapRow(row: any): QueueEntry {
    return {
      id: row.id,
      url: row.url,
      sourceId: row.source_id,
      sourceContext: row.source_context,
      authorId: row.author_id,
      status: row.status,
      attempts: row.attempts,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      processedAt: row.processed_at,
    };
  }
}
