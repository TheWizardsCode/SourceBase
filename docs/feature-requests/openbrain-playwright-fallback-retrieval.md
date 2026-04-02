# Feature Request: Playwright Fallback for Content Retrieval Failures

## Summary

OpenBrain should use a headless Playwright browser as a fallback when the standard retrieval path fails to return usable content.

## Problem

Some pages are rendered mostly or fully through JavaScript. The current retrieval path can fail on these pages, returning empty or low-value content, which then causes extraction and summarization to fail.

## Why this matters

- Shared links in Discord can fail ingestion even when the page is valid in a normal browser.
- Community knowledge capture quality drops when JavaScript-heavy sites cannot be indexed.
- Operators currently have no reliable fallback for blocked or dynamically rendered content.

## Current architecture context

SourceBase (Discord bot) does not implement page retrieval directly. It delegates ingestion to OpenBrain via `ob add`.

Because of this separation, the fallback logic belongs in OpenBrain, not in SourceBase.

## Requested behavior

1. Attempt the current retrieval path first (fast path).
2. If retrieval or extraction fails due to known failure modes (for example: blocked response, script-rendered content, empty extraction), retry with Playwright.
3. Feed Playwright-derived HTML/content into the existing extraction flow so downstream behavior stays consistent.
4. Emit clear telemetry/event data when fallback is used.

## Acceptance criteria

- OpenBrain continues to use the existing retrieval path by default.
- OpenBrain invokes Playwright fallback only when the fast path fails or yields unusable content.
- JavaScript-heavy pages that previously failed can now be ingested successfully when fallback is enabled.
- Timeout and resource controls exist for browser-based fallback.
- Logs or progress output make fallback activation visible for diagnostics.
- Automated tests cover success and failure cases for both fast path and fallback path.

## Non-goals

- Implementing custom retrieval logic in the SourceBase Discord bot.
- Making Playwright the primary path for all URLs.

## Related work

- Work item: Use playright retrieve content if existing retrieval path fails (SB-0MNHOYCUK000RALJ)
- Historical draft (deleted): Add Playwright fallback for blocked content extraction (SB-0MN4FHM2B0PI69AE)
