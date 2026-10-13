import { sha256Hex } from "../../../shared/files/hash";
import { extractPaperMetadata } from "../../../shared/pdf/extractMetadata";
import { monthNumber } from "../../../shared/types";
import { prioritizeCandidate, type SourceAdapter } from "../crawler/adapter";
import { PermanentFetchError } from "../crawler/fetcher";
import type { ImportItem, ImportJob, ItemUpdate, JobStore } from "./types";

export interface PdfFetcher {
  fetchPdf(url: string): Promise<{ url: string; bytes: Uint8Array }>;
}

export interface RunnerDeps {
  store: JobStore;
  adapter: SourceAdapter;
  fetcher: PdfFetcher;
  extractText(bytes: Uint8Array): Promise<{ text: string; numPages: number }>;
  /** Optional OCR for unreadable first pages. Returns null when OCR is unavailable. */
  ocr?: (bytes: Uint8Array) => Promise<string | null>;
  maxDownloadsPerJob: number;
  maxItemAttempts: number;
  retryBaseMs: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type RunOutcome = "completed" | "cancelled" | "failed";

class JobCancelled extends Error {}

const MAX_TEXT_STORED = 8000;

/**
 * Runs one import job to completion. Every step is persisted, so a job that
 * is interrupted (crash, deploy, timeout) can be claimed again and continues
 * where it left off:
 *   discover  → links are upserted by (job_id, source_url), so re-crawling is idempotent
 *   process   → only items still in `discovered` / `retry` are processed
 */
export async function runImportJob(job: ImportJob, deps: RunnerDeps): Promise<RunOutcome> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const checkCancelled = async () => {
    const status = await store.heartbeat(job.id);
    if (status === "cancelled") throw new JobCancelled();
  };

  try {
    await store.log(job.id, "info", `Worker started (attempt ${job.attempts}, phase ${job.phase})`, {
      codes: job.course_codes.length,
      keyword: job.keyword,
    });

    if (job.phase === "discover") {
      await discover(job, deps, checkCancelled);
      await store.setPhase(job.id, "process");
    }

    await processItems(job, deps, checkCancelled, now, sleep);

    await store.setPhase(job.id, "done");
    await store.finishJob(job.id, "completed");
    await store.log(job.id, "info", "Job completed");
    return "completed";
  } catch (err) {
    if (err instanceof JobCancelled) {
      await store.log(job.id, "warn", "Job cancelled; stopping");
      return "cancelled";
    }
    const message = err instanceof Error ? err.message : String(err);
    await store.log(job.id, "error", `Job failed: ${message}`);
    await store.finishJob(job.id, "failed", message);
    return "failed";
  }
}

async function discover(job: ImportJob, deps: RunnerDeps, checkCancelled: () => Promise<void>) {
  const { store, adapter } = deps;
  let kept = 0;
  let filtered = 0;
  let batch: Parameters<JobStore["insertDiscovered"]>[1] = [];
  const flush = async () => {
    if (batch.length) await store.insertDiscovered(job.id, batch);
    batch = [];
  };
  for await (const link of adapter.discover({
    keyword: job.keyword,
    targetCodes: job.course_codes,
    onPage: async (p) => {
      await flush();
      await store.setPagesCrawled(job.id, p.pagesCrawled);
      await checkCancelled();
    },
  })) {
    const decision = prioritizeCandidate(link, job.course_codes, job.keyword);
    if (!decision.keep) {
      filtered++;
      continue;
    }
    kept++;
    let filename = link.url.split("/").pop() ?? "document.pdf";
    try {
      filename = decodeURIComponent(filename.split("?")[0]!);
    } catch {
      /* keep raw */
    }
    batch.push({
      source_url: link.url,
      link_text: [link.text, link.trail].filter(Boolean).join(" | ").slice(0, 500),
      discovered_on: link.foundOn,
      discovery_priority: decision.priority,
      original_filename: filename.slice(0, 255),
    });
    if (batch.length >= 50) await flush();
  }
  await flush();
  await store.log(job.id, "info", `Discovery finished: ${kept} candidate PDFs, ${filtered} links filtered out by keyword`);
  if (kept === 0) {
    await store.log(job.id, "warn", "No candidate PDFs were found. The source structure may have changed or access may be restricted — run `npm run crawler:probe`.");
  }
}

async function processItems(
  job: ImportJob,
  deps: RunnerDeps,
  checkCancelled: () => Promise<void>,
  now: () => Date,
  sleep: (ms: number) => Promise<void>,
) {
  const { store } = deps;
  let downloaded = await store.countDownloaded(job.id);
  for (;;) {
    await checkCancelled();
    if (downloaded >= deps.maxDownloadsPerJob) {
      const skipped = await store.skipRemaining(job.id, `Per-job download limit (${deps.maxDownloadsPerJob}) reached`);
      if (skipped > 0) {
        await store.log(job.id, "warn", `Download limit reached: ${skipped} candidates were skipped (not lost — resume the job or raise CRAWLER_MAX_DOWNLOADS_PER_JOB).`);
      }
      return;
    }
    const items = await store.nextItems(job.id, Math.min(10, deps.maxDownloadsPerJob - downloaded), now().toISOString());
    if (items.length === 0) {
      const retryAt = await store.nextRetryAt(job.id);
      if (!retryAt) return;
      await sleep(Math.max(0, Math.min(60_000, new Date(retryAt).getTime() - now().getTime())));
      continue;
    }
    for (const item of items) {
      await checkCancelled();
      const counted = await processItem(job, item, deps, now);
      if (counted) downloaded++;
      if (downloaded >= deps.maxDownloadsPerJob) break;
    }
  }
}

/** Returns true when the item consumed a download. */
async function processItem(job: ImportJob, item: ImportItem, deps: RunnerDeps, now: () => Date): Promise<boolean> {
  const { store } = deps;
  const attempts = item.attempts + 1;
  let bytes: Uint8Array;
  try {
    bytes = (await deps.fetcher.fetchPdf(item.source_url)).bytes;
  } catch (err) {
    await failOrRetry(job, item, attempts, err, deps, now);
    return false;
  }

  try {
    const sha256 = await sha256Hex(bytes);
    const base: Partial<ItemUpdate> = { attempts, sha256, size_bytes: bytes.byteLength, last_error: null, next_attempt_at: null };

    const paperId = await store.findPaperByHash(sha256);
    if (paperId) {
      await store.updateItem(item.id, { ...base, status: "duplicate", duplicate_of_paper_id: paperId });
      return true;
    }
    const other = await store.findItemByHash(sha256, item.id);
    if (other) {
      await store.updateItem(item.id, {
        ...base,
        status: "duplicate",
        last_error: `Same file as review item ${other.id} (${other.status})`,
      });
      return true;
    }

    let text = "";
    try {
      text = (await deps.extractText(bytes)).text;
    } catch (err) {
      await store.updateItem(item.id, { ...base, status: "failed", last_error: `PDF could not be parsed: ${(err as Error).message}` });
      await store.log(job.id, "error", `Unparseable PDF ${item.source_url}`);
      return true;
    }

    let ocrNote: string | null = null;
    if (text.replace(/\s+/g, "").length < 40 && deps.ocr) {
      const ocrText = await deps.ocr(bytes).catch((e: Error) => {
        ocrNote = `OCR failed: ${e.message}`;
        return null;
      });
      if (ocrText) {
        text = ocrText;
        ocrNote = "Text obtained by OCR (tesseract) — verify carefully.";
      }
    }

    const meta = extractPaperMetadata(text, {
      targetCodes: job.course_codes,
      filename: item.original_filename,
      linkText: item.link_text,
      now: now(),
    });
    if (ocrNote) meta.warnings.unshift(ocrNote);

    const isTarget =
      meta.codeMatch.status === "matched" ||
      meta.codeMatch.status === "multiple" ||
      // Unreadable PDF whose link/filename points at a target: keep it for a human to check.
      (meta.codeMatch.status === "no_text" && meta.codeMatch.hintedCodes.some((c) => job.course_codes.includes(c)));

    const stagingPath = await store.uploadStaging(sha256, bytes);
    await store.updateItem(item.id, {
      ...base,
      status: isTarget ? "pending_review" : "unmatched",
      staging_path: stagingPath,
      first_page_text: text.slice(0, MAX_TEXT_STORED),
      extracted: meta,
      match_status: meta.codeMatch.status,
      confidence: meta.confidence,
      warnings: meta.warnings,
      course_code: meta.courseCode,
      course_title: meta.courseTitle,
      department_name: meta.department,
      semester: meta.semester,
      course_type: meta.courseType,
      kind: meta.kind,
      exam_month: monthNumber(meta.examMonth),
      exam_year: meta.examYear,
    });
    return true;
  } catch (err) {
    await failOrRetry(job, item, attempts, err, deps, now);
    return true;
  }
}

async function failOrRetry(job: ImportJob, item: ImportItem, attempts: number, err: unknown, deps: RunnerDeps, now: () => Date) {
  const message = err instanceof Error ? err.message : String(err);
  const permanent = err instanceof PermanentFetchError;
  if (!permanent && attempts < deps.maxItemAttempts) {
    const delay = deps.retryBaseMs * 2 ** (attempts - 1);
    await deps.store.updateItem(item.id, {
      status: "retry",
      attempts,
      last_error: message,
      next_attempt_at: new Date(now().getTime() + delay).toISOString(),
    });
    await deps.store.log(job.id, "warn", `Will retry ${item.source_url} (attempt ${attempts}/${deps.maxItemAttempts}): ${message}`);
  } else {
    await deps.store.updateItem(item.id, { status: "failed", attempts, last_error: message, next_attempt_at: null });
    await deps.store.log(job.id, "error", `Failed ${item.source_url}: ${message}`);
  }
}
