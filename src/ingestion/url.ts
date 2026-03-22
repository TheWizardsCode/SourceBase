const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  const normalized = matches.map((raw) => raw.replace(/[),.;!?]+$/g, ""));
  return Array.from(new Set(normalized));
}
