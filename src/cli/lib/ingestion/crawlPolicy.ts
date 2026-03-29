import type { Logger } from "../logger.js";

interface CrawlPolicyRuleSet {
  allow: string[];
  disallow: string[];
  crawlDelayMs: number | null;
}

interface HostPolicy {
  rulesByAgent: Map<string, CrawlPolicyRuleSet>;
}

export interface CrawlPolicy {
  canFetch(url: string): Promise<boolean>;
  waitBeforeFetch(url: string): Promise<void>;
}

export interface RobotsTxtCrawlPolicyOptions {
  logger: Logger;
  userAgent: string;
  fallbackDelayMs: number;
}

export class RobotsTxtCrawlPolicy implements CrawlPolicy {
  private readonly hostPolicyCache = new Map<string, Promise<HostPolicy>>();
  private readonly lastRequestAt = new Map<string, number>();

  constructor(private readonly options: RobotsTxtCrawlPolicyOptions) {}

  async canFetch(url: string): Promise<boolean> {
    const target = new URL(url);
    const hostPolicy = await this.getHostPolicy(target.origin);
    const rules = this.resolveRulesForUserAgent(hostPolicy);
    if (!rules) {
      return true;
    }

    return isAllowedByRules(url, rules);
  }

  async waitBeforeFetch(url: string): Promise<void> {
    const target = new URL(url);
    const hostPolicy = await this.getHostPolicy(target.origin);
    const rules = this.resolveRulesForUserAgent(hostPolicy);
    const requiredDelayMs = rules?.crawlDelayMs ?? this.options.fallbackDelayMs;

    if (requiredDelayMs <= 0) {
      this.lastRequestAt.set(target.origin, Date.now());
      return;
    }

    const lastRequestTime = this.lastRequestAt.get(target.origin);
    if (typeof lastRequestTime === "number") {
      const elapsedMs = Date.now() - lastRequestTime;
      const remainingMs = requiredDelayMs - elapsedMs;
      if (remainingMs > 0) {
        await sleep(remainingMs);
      }
    }

    this.lastRequestAt.set(target.origin, Date.now());
  }

  private async getHostPolicy(origin: string): Promise<HostPolicy> {
    const cached = this.hostPolicyCache.get(origin);
    if (cached) {
      return cached;
    }

    const loading = this.loadHostPolicy(origin);
    this.hostPolicyCache.set(origin, loading);
    return loading;
  }

  private async loadHostPolicy(origin: string): Promise<HostPolicy> {
    const robotsUrl = new URL("/robots.txt", origin).toString();
    try {
      const response = await fetch(robotsUrl);
      if (!response.ok) {
        this.options.logger.debug("robots.txt unavailable, allowing crawl", {
          robotsUrl,
          status: response.status
        });
        return { rulesByAgent: new Map() };
      }

      const content = await response.text();
      return {
        rulesByAgent: parseRobotsTxt(content)
      };
    } catch (error) {
      this.options.logger.warn("Failed to fetch robots.txt, allowing crawl", {
        robotsUrl,
        error: error instanceof Error ? error.message : String(error)
      });
      return { rulesByAgent: new Map() };
    }
  }

  private resolveRulesForUserAgent(hostPolicy: HostPolicy): CrawlPolicyRuleSet | null {
    const exact = hostPolicy.rulesByAgent.get(this.options.userAgent.toLowerCase());
    if (exact) {
      return exact;
    }

    const wildcard = hostPolicy.rulesByAgent.get("*");
    return wildcard ?? null;
  }
}

function parseRobotsTxt(content: string): Map<string, CrawlPolicyRuleSet> {
  const result = new Map<string, CrawlPolicyRuleSet>();
  let activeAgents: string[] = [];

  for (const rawLine of content.split(/\r?\n/u)) {
    const lineWithoutComment = rawLine.split("#", 1)[0] ?? "";
    const line = lineWithoutComment.trim();
    if (!line) {
      activeAgents = [];
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (directive === "user-agent") {
      const agent = value.toLowerCase();
      if (!agent) {
        continue;
      }
      activeAgents.push(agent);
      ensureRuleSet(result, agent);
      continue;
    }

    if (!activeAgents.length) {
      continue;
    }

    for (const agent of activeAgents) {
      const ruleSet = ensureRuleSet(result, agent);
      if (directive === "allow") {
        ruleSet.allow.push(value);
      } else if (directive === "disallow") {
        ruleSet.disallow.push(value);
      } else if (directive === "crawl-delay") {
        const asNumber = Number(value);
        if (Number.isFinite(asNumber) && asNumber >= 0) {
          ruleSet.crawlDelayMs = Math.round(asNumber * 1000);
        }
      }
    }
  }

  return result;
}

function ensureRuleSet(target: Map<string, CrawlPolicyRuleSet>, agent: string): CrawlPolicyRuleSet {
  const existing = target.get(agent);
  if (existing) {
    return existing;
  }

  const created: CrawlPolicyRuleSet = {
    allow: [],
    disallow: [],
    crawlDelayMs: null
  };
  target.set(agent, created);
  return created;
}

function isAllowedByRules(targetUrl: string, rules: CrawlPolicyRuleSet): boolean {
  const target = new URL(targetUrl);
  const path = `${target.pathname}${target.search}`;

  let winningRule: { allow: boolean; length: number } | null = null;

  const consider = (patterns: string[], allow: boolean): void => {
    for (const pattern of patterns) {
      if (!pattern) {
        continue;
      }

      if (!matchesPattern(path, pattern)) {
        continue;
      }

      const candidate = { allow, length: pattern.length };
      if (!winningRule || candidate.length > winningRule.length || (candidate.length === winningRule.length && allow)) {
        winningRule = candidate;
      }
    }
  };

  consider(rules.disallow, false);
  consider(rules.allow, true);

  const decidedRule = winningRule as { allow: boolean; length: number } | null;
  return decidedRule?.allow ?? true;
}

function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("$")) {
    return path.startsWith(pattern);
  }

  const escaped = escapeRegExp(pattern)
    .replace(/\\\*/gu, ".*")
    .replace(/\\\$/gu, "$");
  const regex = new RegExp(`^${escaped}`, "u");
  return regex.test(path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
