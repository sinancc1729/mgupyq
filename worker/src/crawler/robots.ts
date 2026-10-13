/**
 * Minimal robots.txt support (RFC 9309): user-agent groups, Allow/Disallow
 * with longest-match precedence, `*` and `$` wildcards, and Crawl-delay.
 */
export interface RobotsRules {
  isAllowed(pathAndQuery: string): boolean;
  crawlDelayMs: number | null;
}

interface Group {
  agents: string[];
  rules: { allow: boolean; pattern: string }[];
  crawlDelay: number | null;
}

export const ALLOW_ALL: RobotsRules = { isAllowed: () => true, crawlDelayMs: null };
export const DISALLOW_ALL: RobotsRules = { isAllowed: () => false, crawlDelayMs: null };

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(txt: string, userAgent: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value === "" && key === "disallow") continue; // "Disallow:" (empty) = allow all
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  const token = userAgent.split("/")[0]!.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules).map((r) => ({ ...r, re: patternToRegex(r.pattern) }));
  const delay = chosen.map((g) => g.crawlDelay).find((d) => d != null) ?? null;
  return {
    crawlDelayMs: delay == null ? null : delay * 1000,
    isAllowed(p: string) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (r.re.test(p) && (!best || r.pattern.length > best.len || (r.pattern.length === best.len && r.allow))) {
          best = { allow: r.allow, len: r.pattern.length };
        }
      }
      return best ? best.allow : true;
    },
  };
}
