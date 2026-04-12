// Shared Discord formatting utilities and policies
export const DISCORD_CONTENT_LIMIT = 1900;
export const MARKDOWN_WRAP_WIDTH = 80;

export function wrapLineAtNearestSpace(line: string, width: number): string[] {
  if (line.length <= width || width <= 0) {
    return [line];
  }

  const bulletMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  const quoteMatch = line.match(/^(\s*>+\s*)(.*)$/);
  const leadingWhitespace = line.match(/^\s*/)?.[0] ?? "";

  let firstPrefix = leadingWhitespace;
  let continuationPrefix = leadingWhitespace;
  let remaining = line.slice(leadingWhitespace.length);

  if (bulletMatch) {
    const indent = bulletMatch[1];
    const marker = bulletMatch[2];
    firstPrefix = `${indent}${marker} `;
    continuationPrefix = `${indent}${" ".repeat(marker.length + 1)}`;
    remaining = bulletMatch[3];
  } else if (quoteMatch) {
    firstPrefix = quoteMatch[1];
    continuationPrefix = quoteMatch[1];
    remaining = quoteMatch[2];
  }

  const wrapped: string[] = [];
  let isFirstLine = true;

  while (remaining.length > 0) {
    const prefix = isFirstLine ? firstPrefix : continuationPrefix;
    const available = width - prefix.length;
    if (available <= 0) {
      wrapped.push(`${prefix}${remaining}`);
      break;
    }

    if (remaining.length <= available) {
      wrapped.push(`${prefix}${remaining}`);
      break;
    }

    let splitIndex = remaining.lastIndexOf(" ", available);
    if (splitIndex <= 0) {
      splitIndex = remaining.indexOf(" ", available);
      if (splitIndex === -1) {
        wrapped.push(`${prefix}${remaining}`);
        break;
      }
    }

    const chunk = remaining.slice(0, splitIndex).trimEnd();
    wrapped.push(`${prefix}${chunk}`);
    remaining = remaining.slice(splitIndex).trimStart();
    isFirstLine = false;
  }

  return wrapped.length > 0 ? wrapped : [line];
}

export function wrapMarkdownText(content: string, width = MARKDOWN_WRAP_WIDTH): string {
  const lines = content.split("\n");
  const wrapped: string[] = [];
  let inFencedCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFencedCodeBlock = !inFencedCodeBlock;
      wrapped.push(line);
      continue;
    }

    if (
      inFencedCodeBlock ||
      line.length <= width ||
      /^\s*\|/.test(line) ||
      /^\s*\[[^\]]+\]:\s+\S+/.test(line)
    ) {
      wrapped.push(line);
      continue;
    }

    wrapped.push(...wrapLineAtNearestSpace(line, width));
  }

  return wrapped.join("\n");
}

export function extractSummaryFromMarkdown(content: string, maxLen = 1500): string {
  try {
    const summaryRegex = /(^|\n)#{1,6}\s*summary\s*\n([\s\S]*?)(?=\n#{1,6}\s*\S|\n---|$)/i;
    const m = content.match(summaryRegex);
    if (m && m[2]) {
      let s = m[2].trim();
      if (s.length > maxLen) s = s.slice(0, maxLen).trim();
      const lastPeriod = s.lastIndexOf('. ');
      if (lastPeriod > Math.floor(maxLen / 2)) s = s.slice(0, lastPeriod + 1);
      return s;
    }
  } catch {
    // ignore
  }

  const paragraphs = content.split(/\n\s*\n/);
  let first = (paragraphs[0] || '').trim();
  if (!first && paragraphs.length > 1) first = (paragraphs[1] || '').trim();
  if (first) {
    if (first.length <= maxLen) return first;
    const truncated = first.slice(0, maxLen);
    const lastPeriod = truncated.lastIndexOf('. ');
    if (lastPeriod > 0) return truncated.slice(0, lastPeriod + 1);
    return truncated;
  }

  let truncated = content.slice(0, maxLen);
  const lastPeriod = truncated.lastIndexOf('. ');
  if (lastPeriod > 0) truncated = truncated.slice(0, lastPeriod + 1);
  return truncated;
}

export function renderBriefingFromJson(jsonOut: any): string {
  if (typeof jsonOut === "string") return jsonOut;

  if (Array.isArray(jsonOut)) {
    if (jsonOut.every((el) => typeof el === "string")) {
      return jsonOut.join("\n\n");
    }

    const parts: string[] = jsonOut
      .map((el) => {
        if (!el && el !== 0) return "";
        if (typeof el === "string") return el;
        if (typeof el === "object") {
          const title = el.title || el.name || el.heading;
          const content = el.briefing || el.summary || el.text || el.body || el.markdown || el.md || el.content;
          if (title && typeof content === "string") {
            return `## ${String(title).trim()}\n\n${content.trim()}`;
          }
          return renderBriefingFromJson(el);
        }
        return String(el);
      })
      .filter(Boolean);

    if (parts.length > 0) return parts.join("\n\n");
    return JSON.stringify(jsonOut, null, 2);
  }

  if (jsonOut && typeof jsonOut === "object") {
    const preferred = ["briefing", "markdown", "md", "summary", "text", "body", "content"];
    for (const k of preferred) {
      if (k in jsonOut && typeof (jsonOut as any)[k] === "string" && (jsonOut as any)[k].trim()) {
        return (jsonOut as any)[k];
      }
    }

    if (Array.isArray((jsonOut as any).sections)) {
      const parts = (jsonOut as any).sections
        .map((s: any) => {
          if (!s && s !== 0) return "";
          if (typeof s === "string") return s;
          if (typeof s === "object") {
            const title = s.title || s.heading || s.name;
            const content = s.content || s.briefing || s.summary || s.text || s.body || s.markdown || s.md;
            if (title) return `## ${String(title).trim()}\n\n${renderBriefingFromJson(content || s)}`;
            return renderBriefingFromJson(s);
          }
          return String(s);
        })
        .filter(Boolean);

      if (parts.length > 0) return parts.join("\n\n");
    }

    const keys = Object.keys(jsonOut);
    if (keys.length > 0) {
      const parts = keys
        .map((k) => {
          const v = (jsonOut as any)[k];
          if (v === undefined || v === null) return "";
          let content: string;
          if (typeof v === "string") content = v;
          else if (Array.isArray(v)) content = v.map((el) => (typeof el === "string" ? el : JSON.stringify(el))).join("\n\n");
          else if (typeof v === "object") content = renderBriefingFromJson(v);
          else content = String(v);
          return `## ${k}\n\n${content}`;
        })
        .filter(Boolean);

      if (parts.length > 0) return parts.join("\n\n");
    }
  }

  try {
    return JSON.stringify(jsonOut, null, 2);
  } catch {
    return String(jsonOut);
  }
}

export function truncate(content: string, maxLen: number): string {
  if (typeof content !== "string") return String(content);
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + "...";
}
