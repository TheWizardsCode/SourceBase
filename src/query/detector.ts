const QUERY_PREFIXES = [
  "what",
  "which",
  "where",
  "when",
  "why",
  "how",
  "who",
  "is",
  "are",
  "can",
  "could",
  "do",
  "did",
  "does",
  "any"
];

const LINK_SEARCH_HINTS = [
  "link",
  "links",
  "article",
  "read",
  "shared",
  "post",
  "resource",
  "topic",
  "about"
];

export function isLikelyContentQuery(messageContent: string): boolean {
  const trimmed = messageContent.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }

  const hasQuestionMark = trimmed.includes("?");
  const startsLikeQuestion = QUERY_PREFIXES.some((prefix) => trimmed.startsWith(`${prefix} `));
  const hasSearchHint = LINK_SEARCH_HINTS.some((hint) => trimmed.includes(hint));

  return hasQuestionMark || (startsLikeQuestion && hasSearchHint);
}
