import { describe, it, expect } from "vitest";
import { formatProgressMessage } from "../../src/index.js";

describe("formatProgressMessage", () => {
  it("handles known phases", () => {
    expect(formatProgressMessage({ phase: "downloading" } as any)).toBe("⏳ Downloading content...");
    expect(formatProgressMessage({ phase: "extracting" } as any)).toBe("📝 Extracting text content...");
    expect(formatProgressMessage({ phase: "embedding" } as any)).toBe("🧠 Generating embeddings...");
    expect(formatProgressMessage({ phase: "completed", title: "My Title" } as any)).toBe("✅ Added to OpenBrain: My Title");
    expect(formatProgressMessage({ phase: "failed", message: "boom" } as any)).toBe("❌ Failed: boom");
  });

  it("handles missing phase with message and title/url", () => {
    const m1 = formatProgressMessage({ message: "Something went wrong", title: "T" } as any);
    expect(m1).toContain("❌");
    expect(m1).toContain("T");

    const m2 = formatProgressMessage({ message: "Long msg", url: "https://x" } as any);
    expect(m2).toContain("❌");
    expect(m2).toContain("<https://x>");
  });

  it("handles missing phase with no message by listing identifying fields", () => {
    const out = formatProgressMessage({ id: 5, title: "TT", url: "https://u" } as any);
    expect(out).toContain("⏳ Processing: unknown");
    expect(out).toContain("id:5");
    expect(out).toContain("title:TT");
  });

  it("handles unknown phase with message truncation", () => {
    const long = "a".repeat(2000);
    const out = formatProgressMessage({ phase: "weird", message: long } as any);
    expect(out).toContain("Processing: weird");
    expect(out.length).toBeLessThan(1400);
  });
});
