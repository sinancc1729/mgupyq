import { normalizeCourseCode } from "../../../shared/courses/courseCode";
import type { UrlPolicy } from "../../../shared/crawl/url";
import { parseIndexPage, type PdfLink } from "./links";

export interface DiscoveredPdf extends PdfLink {
  /** Index page where the link was found. */
  foundOn: string;
  /** Breadcrumb of index-page link texts that led here (e.g. "FYUGP › Semester 1"). */
  trail: string;
}

export interface DiscoveryProgress {
  pagesCrawled: number;
  pagesQueued: number;
  pdfsFound: number;
}

/**
 * A source adapter turns a website into a stream of candidate PDF links.
 * Swap or extend adapters without touching the import pipeline.
 */
export interface SourceAdapter {
  readonly name: string;
  discover(opts: {
    keyword: string | null;
    targetCodes: string[];
    onPage?: (p: DiscoveryProgress) => Promise<void> | void;
    shouldStop?: () => Promise<boolean> | boolean;
  }): AsyncGenerator<DiscoveredPdf>;
}

export interface HtmlFetcher {
  fetchHtml(url: string): Promise<{ url: string; html: string }>;
}

export interface IndexCrawlerOptions {
  startUrls: string[];
  policy: UrlPolicy;
  pathPrefix: string;
  maxPages: number;
  maxDepth: number;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

/**
 * Adapter for https://assist.mgu.ac.in/schema/.
 *
 * IMPORTANT: the site could not be inspected while this adapter was written
 * (it was unreachable from the build environment). It is therefore a
 * conservative, generic index crawler that works with:
 *   - plain HTML pages that link to PDFs (anchors, iframes, <option> pickers),
 *   - Apache/nginx-style directory listings ("Index of /schema/…"),
 *   - paginated listings that use ordinary links or rel="next",
 * restricted to `pathPrefix` on allow-listed hosts. It does NOT submit forms,
 * run JavaScript, log in or solve CAPTCHAs. Run `npm run crawler:probe` against
 * the live site to see what it finds and adjust options (or subclass) if the
 * real structure needs something else — see docs/SOURCE_ADAPTER.md.
 */
export class MguSchemaAdapter implements SourceAdapter {
  readonly name = "mgu-assist-schema";

  constructor(
    private readonly fetcher: HtmlFetcher,
    private readonly opts: IndexCrawlerOptions,
  ) {}

  async *discover({
    keyword,
    targetCodes,
    onPage,
    shouldStop,
  }: Parameters<SourceAdapter["discover"]>[0]): AsyncGenerator<DiscoveredPdf> {
    const kw = keyword?.trim().toLowerCase() || null;
    const codes = targetCodes.map(normalizeCourseCode);
    const relevance = (text: string) => {
      const compact = normalizeCourseCode(text);
      if (codes.some((c) => compact.includes(c))) return 0;
      if (kw && text.toLowerCase().includes(kw)) return 1;
      return 2;
    };

    type QueueItem = { url: string; depth: number; trail: string; prio: number };
    const queue: QueueItem[] = this.opts.startUrls.map((url) => ({ url, depth: 0, trail: "", prio: 0 }));
    const seen = new Set(queue.map((q) => q.url));
    const seenPdfs = new Set<string>();
    let pagesCrawled = 0;

    while (queue.length > 0 && pagesCrawled < this.opts.maxPages) {
      if (shouldStop && (await shouldStop())) return;
      // Most relevant pages first (code hits, then keyword hits, then the rest), BFS within a priority.
      queue.sort((a, b) => a.prio - b.prio || a.depth - b.depth);
      const next = queue.shift()!;
      let page: { url: string; html: string };
      try {
        page = await this.fetcher.fetchHtml(next.url);
      } catch (err) {
        this.opts.log?.("warn", `Could not fetch index page ${next.url}: ${(err as Error).message}`);
        continue;
      }
      pagesCrawled++;
      const parsed = parseIndexPage(page.html, page.url, this.opts.policy, this.opts.pathPrefix);
      for (const pdf of parsed.pdfLinks) {
        if (seenPdfs.has(pdf.url)) continue;
        seenPdfs.add(pdf.url);
        yield { ...pdf, foundOn: page.url, trail: next.trail };
      }
      if (next.depth < this.opts.maxDepth) {
        for (const link of parsed.pageLinks) {
          if (seen.has(link.url)) continue;
          seen.add(link.url);
          const trail = [next.trail, link.text].filter(Boolean).join(" › ").slice(-300);
          queue.push({ url: link.url, depth: next.depth + 1, trail, prio: link.isPagination ? 0 : relevance(`${link.text} ${link.url}`) });
        }
      }
      await onPage?.({ pagesCrawled, pagesQueued: queue.length, pdfsFound: seenPdfs.size });
    }
    if (queue.length > 0) {
      this.opts.log?.("warn", `Stopped after ${pagesCrawled} index pages (CRAWLER_MAX_PAGES); ${queue.length} pages were not visited.`);
    }
  }
}

export type CandidatePriority = 0 | 1 | 2;

/**
 * Decides whether a discovered link is worth downloading, and how urgently.
 * The course-code list always wins: a link that hints at a target code is
 * kept even when it does not mention the department keyword. The keyword only
 * narrows the remaining links. Downloads are still verified by first-page text.
 */
export function prioritizeCandidate(
  link: { url: string; text: string; context: string; trail: string },
  targetCodes: string[],
  keyword: string | null,
): { keep: boolean; priority: CandidatePriority; reason: string } {
  let decodedUrl = link.url;
  try {
    decodedUrl = decodeURIComponent(link.url);
  } catch {
    /* keep raw */
  }
  const haystack = `${link.text} ${link.context} ${link.trail} ${decodedUrl}`;
  const compact = normalizeCourseCode(haystack.replace(/[_\-.]+/g, " "));
  const hit = targetCodes.map(normalizeCourseCode).find((c) => compact.includes(c));
  if (hit) return { keep: true, priority: 0, reason: `link mentions target code ${hit}` };
  const kw = keyword?.trim().toLowerCase();
  if (kw) {
    return haystack.toLowerCase().includes(kw)
      ? { keep: true, priority: 1, reason: `link mentions keyword "${keyword}"` }
      : { keep: false, priority: 2, reason: `no target code or keyword "${keyword}" in link` };
  }
  return { keep: true, priority: 2, reason: "no keyword filter; first page will be inspected" };
}
