/**
 * Crawler probe: fetches the source start page (politely, honouring robots.txt)
 * and prints what the adapter sees — PDF links, followable index pages and
 * ignored links. Use it to verify or adapt the source adapter against the
 * live site. Needs no Supabase credentials.
 *
 *   npm run crawler:probe
 *   npm run crawler:probe -- https://assist.mgu.ac.in/schema/some/page/
 */
import "dotenv/config";
import { PoliteFetcher } from "./crawler/fetcher";
import { parseIndexPage } from "./crawler/links";

const start = process.argv[2] ?? process.env.SOURCE_BASE_URL ?? "https://assist.mgu.ac.in/schema/";
const allowedHosts = (process.env.SOURCE_ALLOWED_HOSTS ?? new URL(start).hostname).split(",").map((s) => s.trim());
const pathPrefix = process.env.SOURCE_PATH_PREFIX ?? "/schema/";

const fetcher = new PoliteFetcher({
  policy: { allowedHosts },
  userAgent: process.env.CRAWLER_USER_AGENT ?? "MGU-PYQ-Hub/1.0 (probe)",
  delayMs: Number(process.env.CRAWLER_DELAY_MS ?? 1500),
  timeoutMs: Number(process.env.CRAWLER_TIMEOUT_MS ?? 30000),
  maxRetries: 1,
  maxPdfBytes: 1,
  respectRobots: process.env.CRAWLER_RESPECT_ROBOTS !== "false",
  log: (level, msg) => console.error(`[${level}] ${msg}`),
});

try {
  const page = await fetcher.fetchHtml(start);
  const parsed = parseIndexPage(page.html, page.url, { allowedHosts }, pathPrefix);
  console.log(`URL:        ${page.url}`);
  console.log(`Title:      ${parsed.title || "(none)"}`);
  console.log(`HTML size:  ${page.html.length} chars`);
  console.log(`Forms:      ${(page.html.match(/<form/gi) ?? []).length} (forms are NOT submitted by the crawler)`);
  console.log(`Scripts:    ${(page.html.match(/<script/gi) ?? []).length} (JavaScript is NOT executed)`);
  console.log(`\nPDF links (${parsed.pdfLinks.length}):`);
  for (const l of parsed.pdfLinks.slice(0, 40)) console.log(`  - ${l.text}  →  ${l.url}`);
  console.log(`\nFollowable index pages (${parsed.pageLinks.length}):`);
  for (const l of parsed.pageLinks.slice(0, 40)) console.log(`  - ${l.isPagination ? "[next] " : ""}${l.text}  →  ${l.url}`);
  console.log(`\nIgnored links (${parsed.ignored.length}):`);
  for (const l of parsed.ignored.slice(0, 20)) console.log(`  - ${l.href}  (${l.reason})`);
  if (parsed.pdfLinks.length === 0 && parsed.pageLinks.length === 0) {
    console.log("\n⚠ Nothing crawlable found. The page may rely on forms/JavaScript; see docs/SOURCE_ADAPTER.md.");
  }
} catch (err) {
  console.error(`Probe failed: ${(err as Error).message}`);
  process.exit(1);
}
