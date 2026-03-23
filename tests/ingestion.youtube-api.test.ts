import { describe, expect, it, vi, beforeEach } from "vitest";

import { YouTubeApiClient, type YouTubeVideoMetadata } from "../src/ingestion/youtube.js";
import type { Logger } from "../src/logger.js";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("YouTubeApiClient", () => {
  let client: YouTubeApiClient;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    client = new YouTubeApiClient(mockLogger, "test-api-key");
    mockFetch.mockClear();
  });

  describe("isConfigured", () => {
    it("returns true when API key is provided", () => {
      expect(client.isConfigured()).toBe(true);
    });

    it("returns false when API key is empty", () => {
      const unconfiguredClient = new YouTubeApiClient(mockLogger, "");
      expect(unconfiguredClient.isConfigured()).toBe(false);
    });

    it("returns false when API key is undefined", () => {
      const unconfiguredClient = new YouTubeApiClient(mockLogger);
      expect(unconfiguredClient.isConfigured()).toBe(false);
    });
  });

  describe("fetchVideoMetadata", () => {
    const mockVideoId = "dQw4w9WgXcQ";
    const mockApiResponse = {
      items: [
        {
          id: mockVideoId,
          snippet: {
            title: "Rick Astley - Never Gonna Give You Up",
            description: "The official video for Never Gonna Give You Up",
            thumbnails: {
              default: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg" },
              medium: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" },
              high: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
            },
            channelTitle: "Rick Astley",
            publishedAt: "2009-10-25T06:57:33Z",
          },
        },
      ],
    };

    it("returns metadata for valid video", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockApiResponse,
      });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result).not.toBeNull();
      expect(result?.videoId).toBe(mockVideoId);
      expect(result?.title).toBe("Rick Astley - Never Gonna Give You Up");
      expect(result?.description).toBe("The official video for Never Gonna Give You Up");
      expect(result?.channelTitle).toBe("Rick Astley");
      expect(result?.publishedAt).toBe("2009-10-25T06:57:33Z");
      expect(result?.thumbnailUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    });

    it("returns null when video not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      });

      const result = await client.fetchVideoMetadata("invalid-video-id");

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "YouTube video not found",
        expect.any(Object)
      );
    });

    it("returns null when API returns 403 (quota exceeded)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "YouTube API quota exceeded or invalid API key",
        expect.any(Object)
      );
    });

    it("returns null when API returns 404", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "YouTube API request failed",
        expect.any(Object)
      );
    });

    it("implements exponential backoff on rate limit (429)", async () => {
      // First two calls return 429, third succeeds
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockApiResponse,
        });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "YouTube API rate limited, backing off",
        expect.any(Object)
      );
    });

    it("returns null after max retries on rate limit", async () => {
      // All calls return 429
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Map(),
      });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(4); // Initial + 3 retries
      expect(mockLogger.error).toHaveBeenCalledWith(
        "YouTube API rate limit exceeded after max retries",
        expect.any(Object)
      );
    }, 15000); // 15 second timeout for exponential backoff delays

    it("respects Retry-After header", async () => {
      const headers = new Map([["Retry-After", "2"]]);
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockApiResponse,
        });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result).not.toBeNull();
      // Should wait 2 seconds (2000ms) as specified in header
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "YouTube API rate limited, backing off",
        expect.objectContaining({ waitTime: 2000 })
      );
    }, 10000); // 10 second timeout for Retry-After delay

    it("handles network errors with retry", async () => {
      mockFetch
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockApiResponse,
        });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Error fetching YouTube metadata",
        expect.any(Object)
      );
    });

    it("returns null after max retries on network error", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(4); // Initial + 3 retries
    }, 15000); // 15 second timeout for exponential backoff delays

    it("returns null when client is not configured", async () => {
      const unconfiguredClient = new YouTubeApiClient(mockLogger, "");
      
      const result = await unconfiguredClient.fetchVideoMetadata(mockVideoId);

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "YouTube API key not configured, skipping metadata fetch",
        expect.any(Object)
      );
    });

    it("selects best available thumbnail", async () => {
      const responseWithMultipleThumbnails = {
        items: [
          {
            id: mockVideoId,
            snippet: {
              title: "Test Video",
              description: "Test description",
              thumbnails: {
                default: { url: "default.jpg" },
                medium: { url: "medium.jpg" },
                high: { url: "high.jpg" },
                standard: { url: "standard.jpg" },
                maxres: { url: "maxres.jpg" },
              },
              channelTitle: "Test Channel",
              publishedAt: "2024-01-01T00:00:00Z",
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => responseWithMultipleThumbnails,
      });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result?.thumbnailUrl).toBe("maxres.jpg");
    });

    it("falls back to lower quality thumbnails when high-res unavailable", async () => {
      const responseWithLowResOnly = {
        items: [
          {
            id: mockVideoId,
            snippet: {
              title: "Test Video",
              description: "Test description",
              thumbnails: {
                default: { url: "default.jpg" },
              },
              channelTitle: "Test Channel",
              publishedAt: "2024-01-01T00:00:00Z",
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => responseWithLowResOnly,
      });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result?.thumbnailUrl).toBe("default.jpg");
    });

    it("handles empty thumbnail object", async () => {
      const responseWithNoThumbnails = {
        items: [
          {
            id: mockVideoId,
            snippet: {
              title: "Test Video",
              description: "Test description",
              thumbnails: {},
              channelTitle: "Test Channel",
              publishedAt: "2024-01-01T00:00:00Z",
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => responseWithNoThumbnails,
      });

      const result = await client.fetchVideoMetadata(mockVideoId);

      expect(result?.thumbnailUrl).toBe("");
    });
  });
});
