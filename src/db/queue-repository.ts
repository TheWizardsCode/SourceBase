import type { Pool } from "pg";

export interface QueueEntry {
  id: number;
  url: string;
  discordMessageId: string;
  discordChannelId: string;
  discordAuthorId: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date;
}

export interface CreateQueueEntry {
  url: string;
  discordMessageId: string;
  discordChannelId: string;
  discordAuthorId: string;
}

export class DocumentQueueRepository {
  constructor(private readonly pool: Pool) {}

  async create(entry: CreateQueueEntry): Promise<QueueEntry> {
    const result = await this.pool.query(
      `INSERT INTO document_queue (url, discord_message_id, discord_channel_id, discord_author_id, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [entry.url, entry.discordMessageId, entry.discordChannelId, entry.discordAuthorId]
    );
    return this.mapRow(result.rows[0]);
  }

  async getPending(): Promise<QueueEntry[]> {
    const result = await this.pool.query(
      `SELECT * FROM document_queue 
       WHERE status = 'pending'
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

  private mapRow(row: any): QueueEntry {
    return {
      id: row.id,
      url: row.url,
      discordMessageId: row.discord_message_id,
      discordChannelId: row.discord_channel_id,
      discordAuthorId: row.discord_author_id,
      status: row.status,
      attempts: row.attempts,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      processedAt: row.processed_at,
    };
  }
}
