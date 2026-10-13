import { lookup as dnsLookup } from "node:dns/promises";
import { checkUrl, isPrivateAddress, type UrlPolicy } from "../../../shared/crawl/url";
import { hasPdfSignature } from "../../../shared/files/hash";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsRules } from "./robots";

export interface FetcherOptions {
  policy: UrlPolicy;
  userAgent: string;
  delayMs: number;
  timeoutMs: number;
  maxRetries: number;
  maxPdfBytes: number;
  maxHtmlBytes?: number;
  respectRobots: boolean;
  fetchImpl?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

/** Errors that should not be retried (404, not a PDF, too large, blocked…). */
export class PermanentFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PermanentFetchError";
  }
}

/** Errors that may succeed later (timeouts, 5xx, 429, connection resets). */
export class TransientFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TransientFetchError";
  }
}

const PDF_TYPES = ["application/pdf", "application/x-pdf", "application/octet-stream", "binary/octet-stream", "application/download", "application/force-download"];
const HTML_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/**
 * A deliberately slow, sequential HTTP client for the source website:
 *  - one request at a time with a minimum delay between requests
 *  - honours robots.txt (and its Crawl-delay) when enabled
 *  - allow-listed hosts only, re-validated on every redirect hop (SSRF)
 *  - refuses hosts that resolve to private addresses
 *  - timeouts, bounded retries with exponential backoff, response size caps
 */
export class PoliteFetcher {
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private robots = new Map<string, RobotsRules>();
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  requestCount = 0;

  constructor(private readonly opts: FetcherOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.lookup = opts.lookup ?? defaultLookup;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  async fetchHtml(url: string): Promise<{ url: string; html: string }> {
    const res = await this.fetchWithRetry(url, "html");
    return { url: res.finalUrl, html: new TextDecoder("utf-8").decode(res.body) };
  }

  async fetchPdf(url: string): Promise<{ url: string; bytes: Uint8Array }> {
    const res = await this.fetchWithRetry(url, "pdf");
    if (!hasPdfSignature(res.body)) throw new PermanentFetchError("Downloaded file is not a PDF (missing %PDF signature)");
    return { url: res.finalUrl, bytes: res.body };
  }

  /** Serialises all requests through one queue so we never flood the source. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchWithRetry(url: string, kind: "html" | "pdf") {
    let attempt = 0;
    for (;;) {
      try {
        return await this.enqueue(() => this.fetchOnce(url, kind));
      } catch (err) {
        if (!(err instanceof TransientFetchError) || attempt >= this.opts.maxRetries) throw err;
        const backoff = Math.min(60_000, this.opts.delayMs * 2 ** (attempt + 1));
        this.opts.log?.("warn", `Retrying ${url} in ${backoff} ms (${err.message})`);
        await this.sleep(backoff);
        attempt++;
      }
    }
  }

  private async assertAllowed(raw: string): Promise<URL> {
    const check = checkUrl(raw, this.opts.policy);
    if (!check.ok) throw new PermanentFetchError(`Blocked URL ${raw}: ${check.reason}`);
    const url = check.url;
    let addrs: string[];
    try {
      addrs = await this.lookup(url.hostname);
    } catch (err) {
      throw new TransientFetchError(`DNS lookup failed for ${url.hostname}: ${(err as Error).message}`);
    }
    if (addrs.length === 0 || addrs.some(isPrivateAddress)) {
      throw new PermanentFetchError(`Host ${url.hostname} resolves to a private or invalid address`);
    }
    if (this.opts.respectRobots) {
      const rules = await this.robotsFor(url);
      if (!rules.isAllowed(url.pathname + url.search)) throw new PermanentFetchError(`Disallowed by robots.txt: ${url.pathname}`);
    }
    return url;
  }

  private async robotsFor(url: URL): Promise<RobotsRules> {
    const key = url.origin;
    const cached = this.robots.get(key);
    if (cached) return cached;
    let rules: RobotsRules = ALLOW_ALL;
    try {
      await this.politeDelay();
      const res = await this.rawFetch(new URL("/robots.txt", url.origin).toString());
      if (res.status >= 200 && res.status < 300) rules = parseRobots(await res.text(), this.opts.userAgent);
      else if (res.status >= 500) {
        rules = DISALLOW_ALL; // RFC 9309: server error ⇒ assume complete disallow
        this.opts.log?.("warn", `robots.txt returned ${res.status}; treating the site as disallowed for now`);
      }
      // 4xx ⇒ no robots.txt ⇒ allowed
    } catch (err) {
      rules = DISALLOW_ALL;
      this.opts.log?.("warn", `robots.txt unreachable (${(err as Error).message}); treating the site as disallowed for now`);
    }
    this.robots.set(key, rules);
    return rules;
  }

  private async politeDelay() {
    const robotsDelay = Math.max(0, ...[...this.robots.values()].map((r) => r.crawlDelayMs ?? 0));
    const wait = this.lastRequestAt + Math.max(this.opts.delayMs, robotsDelay) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  private async rawFetch(url: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    this.requestCount++;
    try {
      return await this.fetchImpl(url, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "User-Agent": this.opts.userAgent, Accept: "text/html,application/pdf;q=0.9,*/*;q=0.1" },
      });
    } catch (err) {
      const e = err as Error;
      throw new TransientFetchError(e.name === "AbortError" ? `Timed out after ${this.opts.timeoutMs} ms` : `Network error: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchOnce(startUrl: string, kind: "html" | "pdf") {
    let current = startUrl;
    for (let hop = 0; hop <= 5; hop++) {
      const url = await this.assertAllowed(current);
      await this.politeDelay();
      const res = await this.rawFetch(url.toString());
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new PermanentFetchError(`Redirect without Location from ${url}`, res.status);
        current = new URL(loc, url).toString(); // re-validated at the top of the loop
        continue;
      }
      if (res.status === 429 || res.status >= 500) throw new TransientFetchError(`HTTP ${res.status} for ${url}`, res.status);
      if (res.status === 401 || res.status === 403) {
        throw new PermanentFetchError(`HTTP ${res.status}: access to ${url} is restricted (no bypass attempted)`, res.status);
      }
      if (res.status < 200 || res.status >= 300) throw new PermanentFetchError(`HTTP ${res.status} for ${url}`, res.status);

      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const allowed = kind === "pdf" ? PDF_TYPES : HTML_TYPES;
      if (type && !allowed.includes(type)) throw new PermanentFetchError(`Unexpected content type "${type}" for ${url}`);
      const limit = kind === "pdf" ? this.opts.maxPdfBytes : (this.opts.maxHtmlBytes ?? 5 * 1024 * 1024);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > limit) throw new PermanentFetchError(`Response is ${declared} bytes, over the ${limit}-byte limit`);
      const body = await readCapped(res, limit);
      return { finalUrl: url.toString(), body };
    }
    throw new PermanentFetchError(`Too many redirects starting at ${startUrl}`);
  }
}

async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw new TransientFetchError(`Connection dropped while downloading: ${(err as Error).message}`);
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PermanentFetchError(`Response exceeded the ${limit}-byte limit`);
    }
    chunks.push(chunk.value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
