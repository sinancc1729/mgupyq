import { parse, type HTMLElement } from "node-html-parser";
import { checkUrl, looksLikePdfUrl, type UrlPolicy } from "../../../shared/crawl/url";

export interface PdfLink {
  url: string;
  /** Visible link text (or filename for bare listings). */
  text: string;
  /** Surrounding row / list item / heading text — extra evidence for filtering. */
  context: string;
}

export interface PageLink {
  url: string;
  text: string;
  /** rel="next" or "Next"/"»" style pagination link. */
  isPagination: boolean;
}

export interface ParsedIndexPage {
  title: string;
  pdfLinks: PdfLink[];
  pageLinks: PageLink[];
  /** Links that were ignored, with the reason (useful for the probe report). */
  ignored: { href: string; reason: string }[];
}

const NON_PAGE_EXT = /\.(jpe?g|png|gif|svg|webp|ico|css|js|mjs|json|xml|zip|rar|7z|docx?|xlsx?|pptx?|mp4|mp3|txt|csv)$/i;
const ws = (s: string) => s.replace(/\s+/g, " ").trim();

function contextOf(el: HTMLElement): string {
  // Prefer the whole table row / list item (filename + date + size + labels),
  // falling back to the nearest cell, paragraph or div.
  let fallback = "";
  let node: HTMLElement | null = el.parentNode as HTMLElement | null;
  for (let i = 0; node && i < 5; i++) {
    const tag = node.rawTagName?.toLowerCase();
    const t = ws(node.textContent);
    if ((tag === "tr" || tag === "li") && t) return t.slice(0, 300);
    if (!fallback && (tag === "p" || tag === "div" || tag === "td") && t) fallback = t.slice(0, 300);
    node = node.parentNode as HTMLElement | null;
  }
  return fallback;
}

function decodeName(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Extracts PDF links and same-site index/pagination links from an HTML page.
 * Handles ordinary anchors, Apache/nginx-style directory listings, iframes and
 * embeds, <option value="…pdf"> pickers, and window.open('…pdf') handlers.
 */
export function parseIndexPage(html: string, pageUrl: string, policy: UrlPolicy, pathPrefix: string): ParsedIndexPage {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: false } });
  const baseHref = root.querySelector("base[href]")?.getAttribute("href");
  const base = baseHref ? new URL(baseHref, pageUrl).toString() : pageUrl;
  const title = ws(root.querySelector("title")?.textContent ?? root.querySelector("h1")?.textContent ?? "");

  const pdfLinks = new Map<string, PdfLink>();
  const pageLinks = new Map<string, PageLink>();
  const ignored: { href: string; reason: string }[] = [];

  const consider = (href: string | undefined, text: string, el: HTMLElement, rel = "") => {
    if (!href) return;
    const h = href.trim();
    if (!h || h.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(h)) return;
    const check = checkUrl(h, policy, base);
    if (!check.ok) {
      ignored.push({ href: h, reason: check.reason });
      return;
    }
    const url = check.url;
    const key = url.toString();
    if (looksLikePdfUrl(url)) {
      if (!pdfLinks.has(key)) pdfLinks.set(key, { url: key, text: ws(text) || decodeName(url), context: contextOf(el) });
      return;
    }
    if (NON_PAGE_EXT.test(url.pathname)) {
      ignored.push({ href: h, reason: "not an HTML page or PDF" });
      return;
    }
    if (!url.pathname.startsWith(pathPrefix)) {
      ignored.push({ href: h, reason: `outside ${pathPrefix}` });
      return;
    }
    // Directory-listing sort links (?C=N;O=D) just reorder the same page.
    if (/^\?C=[NMSD];O=[AD]$/i.test(url.search)) return;
    const t = ws(text);
    if (/^parent directory$/i.test(t)) return;
    const isPagination = /\bnext\b/i.test(rel) || /^(next|next page|›|»|>>|older)$/i.test(t);
    if (!pageLinks.has(key)) pageLinks.set(key, { url: key, text: t, isPagination });
  };

  for (const a of root.querySelectorAll("a[href], area[href]")) consider(a.getAttribute("href"), a.textContent, a, a.getAttribute("rel") ?? "");
  for (const f of root.querySelectorAll("iframe[src], embed[src], frame[src]")) consider(f.getAttribute("src"), "", f);
  for (const o of root.querySelectorAll("object[data]")) consider(o.getAttribute("data"), "", o);
  for (const o of root.querySelectorAll("option[value]")) {
    const v = o.getAttribute("value") ?? "";
    if (/\.pdf(\?|$)/i.test(v)) consider(v, o.textContent, o);
  }
  for (const el of root.querySelectorAll("[onclick]")) {
    const m = /['"]([^'"]+\.pdf(?:\?[^'"]*)?)['"]/i.exec(el.getAttribute("onclick") ?? "");
    if (m) consider(m[1], el.textContent, el);
  }

  // Remove the page itself from the follow-list.
  const self = checkUrl(pageUrl, policy);
  if (self.ok) pageLinks.delete(self.url.toString());

  return { title, pdfLinks: [...pdfLinks.values()], pageLinks: [...pageLinks.values()], ignored };
}
