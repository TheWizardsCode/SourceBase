import { describe, expect, it } from "vitest";

import {
  extractUrls,
  isYouTubeUrl,
  extractYouTubeVideoId,
  normalizeYouTubeUrl,
} from "../src/ingestion/url.js";

describe("extractUrls", () => {
  it("extracts unique URLs from message text", () => {
    const urls = extractUrls(
      "Read https://a.example/x and https://b.example/y and https://a.example/x"
    );
    expect(urls).toEqual(["https://a.example/x", "https://b.example/y"]);
  });

  it("strips trailing punctuation", () => {
    const urls = extractUrls(
      "Check https://a.example/x, then https://b.example/y!"
    );
    expect(urls).toEqual(["https://a.example/x", "https://b.example/y"]);
  });

  it("extracts YouTube URLs from mixed content", () => {
    const text =
      "Check out this video https://youtube.com/watch?v=dQw4w9WgXcQ and this article https://example.com/article";
    const urls = extractUrls(text);
    expect(urls).toContain("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(urls).toContain("https://example.com/article");
    expect(urls).toHaveLength(2);
  });
});

describe("isYouTubeUrl", () => {
  describe("standard watch URLs", () => {
    it("returns true for standard youtube.com/watch URLs", () => {
      expect(
        isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
      ).toBe(true);
      expect(isYouTubeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
        true
      );
    });

    it("returns true for watch URLs with additional parameters", () => {
      expect(
        isYouTubeUrl(
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxx&index=1"
        )
      ).toBe(true);
      expect(
        isYouTubeUrl(
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s"
        )
      ).toBe(true);
    });

    it("returns false for playlist URLs without video ID", () => {
      expect(
        isYouTubeUrl("https://www.youtube.com/playlist?list=PLxxx")
      ).toBe(false);
    });
  });

  describe("short URLs (youtu.be)", () => {
    it("returns true for youtu.be URLs", () => {
      expect(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
      expect(isYouTubeUrl("https://www.youtu.be/dQw4w9WgXcQ")).toBe(true);
    });

    it("returns true for short URLs with additional path", () => {
      expect(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=30s")).toBe(true);
    });
  });

  describe("shorts URLs", () => {
    it("returns true for youtube.com/shorts URLs", () => {
      expect(
        isYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")
      ).toBe(true);
      expect(isYouTubeUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe(true);
    });
  });

  describe("embed URLs", () => {
    it("returns true for youtube.com/embed URLs", () => {
      expect(
        isYouTubeUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")
      ).toBe(true);
      expect(isYouTubeUrl("https://youtube.com/embed/dQw4w9WgXcQ")).toBe(true);
    });
  });

  describe("live URLs", () => {
    it("returns true for youtube.com/live URLs", () => {
      expect(
        isYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcQ")
      ).toBe(true);
      expect(isYouTubeUrl("https://youtube.com/live/dQw4w9WgXcQ")).toBe(true);
    });
  });

  describe("mobile URLs", () => {
    it("returns true for m.youtube.com URLs", () => {
      expect(
        isYouTubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")
      ).toBe(true);
    });
  });

  describe("music URLs", () => {
    it("returns true for music.youtube.com URLs", () => {
      expect(
        isYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ")
      ).toBe(true);
    });
  });

  describe("non-YouTube URLs", () => {
    it("returns false for non-YouTube URLs", () => {
      expect(isYouTubeUrl("https://example.com/video")).toBe(false);
      expect(isYouTubeUrl("https://vimeo.com/123456")).toBe(false);
      expect(isYouTubeUrl("https://twitch.tv/streamer")).toBe(false);
    });

    it("returns false for YouTube channel URLs", () => {
      expect(isYouTubeUrl("https://www.youtube.com/c/ChannelName")).toBe(
        false
      );
      expect(isYouTubeUrl("https://www.youtube.com/user/Username")).toBe(
        false
      );
      expect(isYouTubeUrl("https://www.youtube.com/@ChannelHandle")).toBe(false);
    });

    it("returns false for YouTube playlist URLs", () => {
      expect(
        isYouTubeUrl("https://www.youtube.com/playlist?list=PLxxx")
      ).toBe(false);
    });

    it("returns false for invalid video IDs", () => {
      // Too short
      expect(isYouTubeUrl("https://youtu.be/short")).toBe(false);
      // Too long
      expect(isYouTubeUrl("https://youtu.be/waytoolongvideoid")).toBe(false);
      // Invalid characters
      expect(isYouTubeUrl("https://youtu.be/invalid*chars")).toBe(false);
    });
  });
});

describe("extractYouTubeVideoId", () => {
  describe("extracts video ID from various URL formats", () => {
    it("extracts from standard watch URLs", () => {
      expect(
        extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
      ).toBe("dQw4w9WgXcQ");
      expect(
        extractYouTubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ")
      ).toBe("dQw4w9WgXcQ");
    });

    it("extracts from short URLs", () => {
      expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe(
        "dQw4w9WgXcQ"
      );
      expect(extractYouTubeVideoId("https://www.youtu.be/dQw4w9WgXcQ")).toBe(
        "dQw4w9WgXcQ"
      );
    });

    it("extracts from shorts URLs", () => {
      expect(
        extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")
      ).toBe("dQw4w9WgXcQ");
    });

    it("extracts from embed URLs", () => {
      expect(
        extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")
      ).toBe("dQw4w9WgXcQ");
    });

    it("extracts from live URLs", () => {
      expect(
        extractYouTubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")
      ).toBe("dQw4w9WgXcQ");
    });

    it("extracts from mobile URLs", () => {
      expect(
        extractYouTubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")
      ).toBe("dQw4w9WgXcQ");
    });

    it("extracts from music URLs", () => {
      expect(
        extractYouTubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ")
      ).toBe("dQw4w9WgXcQ");
    });
  });

  describe("handles URL parameters", () => {
    it("extracts video ID with playlist parameter", () => {
      expect(
        extractYouTubeVideoId(
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxx"
        )
      ).toBe("dQw4w9WgXcQ");
    });

    it("extracts video ID with timestamp", () => {
      expect(
        extractYouTubeVideoId(
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s"
        )
      ).toBe("dQw4w9WgXcQ");
      expect(
        extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=30s")
      ).toBe("dQw4w9WgXcQ");
    });

    it("extracts video ID with multiple parameters", () => {
      expect(
        extractYouTubeVideoId(
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxx&index=2&t=45s"
        )
      ).toBe("dQw4w9WgXcQ");
    });
  });

  describe("returns null for invalid URLs", () => {
    it("returns null for non-YouTube URLs", () => {
      expect(extractYouTubeVideoId("https://example.com/video")).toBeNull();
      expect(extractYouTubeVideoId("https://vimeo.com/123456")).toBeNull();
    });

    it("returns null for channel URLs", () => {
      expect(
        extractYouTubeVideoId("https://www.youtube.com/c/ChannelName")
      ).toBeNull();
    });

    it("returns null for invalid video IDs", () => {
      expect(extractYouTubeVideoId("https://youtu.be/short")).toBeNull();
      expect(
        extractYouTubeVideoId("https://youtu.be/waytoolongvideoid")
      ).toBeNull();
    });
  });

  describe("handles edge cases", () => {
    it("handles URLs with underscores", () => {
      const idWithUnderscore = "abc_def1234";  // 11 chars
      expect(
        extractYouTubeVideoId(`https://youtu.be/${idWithUnderscore}`)
      ).toBe(idWithUnderscore);
    });
    
    it("handles URLs with hyphens in the middle", () => {
      const idWithHyphen = "abc-def1234";    // 11 chars: abc(3) -(1) def(3) 1234(4)
      expect(
        extractYouTubeVideoId(`https://youtu.be/${idWithHyphen}?t=30`)
      ).toBe(idWithHyphen);
    });

    it("handles HTTP protocol", () => {
      expect(
        extractYouTubeVideoId("http://www.youtube.com/watch?v=dQw4w9WgXcQ")
      ).toBe("dQw4w9WgXcQ");
    });

    it("is case-insensitive for protocol but preserves video ID case", () => {
      // YouTube video IDs are case-sensitive
      expect(
        extractYouTubeVideoId("https://YOUTUBE.COM/watch?v=dQw4w9WgXcQ")
      ).toBe("dQw4w9WgXcQ");
    });
  });
});

describe("normalizeYouTubeUrl", () => {
  it("normalizes various formats to standard watch URL", () => {
    const videoId = "dQw4w9WgXcQ";
    const expected = `https://www.youtube.com/watch?v=${videoId}`;

    expect(normalizeYouTubeUrl(`https://youtu.be/${videoId}`)).toBe(expected);
    expect(
      normalizeYouTubeUrl(`https://youtube.com/watch?v=${videoId}`)
    ).toBe(expected);
    expect(
      normalizeYouTubeUrl(`https://youtube.com/shorts/${videoId}`)
    ).toBe(expected);
  });

  it("returns null for invalid URLs", () => {
    expect(normalizeYouTubeUrl("https://example.com")).toBeNull();
    expect(normalizeYouTubeUrl("not-a-url")).toBeNull();
  });

  it("strips extra parameters in normalized URL", () => {
    expect(
      normalizeYouTubeUrl(
        "https://youtu.be/dQw4w9WgXcQ?t=30s&feature=share"
      )
    ).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

describe("real YouTube URLs", () => {
  // Test with actual popular YouTube video URLs to validate patterns
  const realVideoUrls = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // Rick Astley - Never Gonna Give You Up
    "https://youtu.be/dQw4w9WgXcQ", // Short URL
    "https://www.youtube.com/watch?v=9bZkp7q19f0", // PSY - Gangnam Style
    "https://youtu.be/9bZkp7q19f0",
    "https://www.youtube.com/shorts/abcdefghijk", // Shorts format with valid ID
    "https://www.youtube.com/embed/abcdefghijk", // Embed format with valid ID
  ];

  it("correctly identifies all real YouTube video URLs", () => {
    realVideoUrls.forEach((url) => {
      expect(isYouTubeUrl(url)).toBe(true);
      expect(extractYouTubeVideoId(url)).not.toBeNull();
    });
  });
});
