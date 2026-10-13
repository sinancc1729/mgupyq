/**
 * MGU PYQ Hub background import worker.
 *
 *   npm run worker        # long-running: polls for queued jobs
 *   npm run worker:once   # processes queued/stale jobs then exits (cron / GitHub Actions)
 *
 * Uses the Supabase service role key — run it only on a trusted server.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { normalizeCodeList } from "../../shared/courses/courseCode";
import { loadConfig, readTargetCodesFile } from "./config";
import { MguSchemaAdapter } from "./crawler/adapter";
import { PoliteFetcher } from "./crawler/fetcher";
import { SupabaseJobStore } from "./jobs/supabaseStore";
import { runImportJob } from "./jobs/runner";
import type { ImportJob } from "./jobs/types";
import { createOcr } from "./ocr";
import { extractTextNode } from "./pdf";

const cfg = loadConfig();
const once = process.argv.includes("--once");
const db = createClient(cfg.supabaseUrl, cfg.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const store = new SupabaseJobStore(db);
let stopping = false;

const log = (level: "info" | "warn" | "error", msg: string) =>
  console[level === "info" ? "log" : level](`[${new Date().toISOString()}] [${cfg.worker.id}] ${msg}`);

async function syncConfiguredCodes() {
  // Make sure codes from config/target-course-codes.json exist in the DB list.
  const codes = normalizeCodeList(readTargetCodesFile(cfg.targetCodesFile));
  if (codes.length === 0) return;
  const { error } = await db
    .from("target_course_codes")
    .upsert(codes.map((code) => ({ code, origin: "config" })), { onConflict: "code", ignoreDuplicates: true });
  if (error) log("warn", `Could not sync configured course codes: ${error.message}`);
  else log("info", `Configured course codes available: ${codes.length}`);
}

async function claim(): Promise<ImportJob | null> {
  const { data, error } = await db.rpc("claim_import_job", {
    p_worker_id: cfg.worker.id,
    p_stale_seconds: Math.round(cfg.worker.staleJobMs / 1000),
  });
  if (error) throw new Error(`claim_import_job failed: ${error.message}`);
  return ((data as ImportJob[] | null) ?? [])[0] ?? null;
}

async function runOne(job: ImportJob) {
  const fetcher = new PoliteFetcher({
    policy: { allowedHosts: cfg.source.allowedHosts },
    userAgent: cfg.crawler.userAgent,
    delayMs: cfg.crawler.delayMs,
    timeoutMs: cfg.crawler.timeoutMs,
    maxRetries: cfg.crawler.maxRetries,
    maxPdfBytes: cfg.crawler.maxPdfBytes,
    respectRobots: cfg.crawler.respectRobots,
    log: (level, msg) => void store.log(job.id, level, msg),
  });
  const opts = job.options as { maxDownloads?: number };
  const adapter = new MguSchemaAdapter(fetcher, {
    startUrls: [cfg.source.baseUrl],
    policy: { allowedHosts: cfg.source.allowedHosts },
    pathPrefix: cfg.source.pathPrefix,
    maxPages: cfg.crawler.maxPages,
    maxDepth: cfg.crawler.maxDepth,
    log: (level, msg) => void store.log(job.id, level, msg),
  });
  // Heartbeat in the background too, so long downloads don't look like a crash.
  const beat = setInterval(() => void store.heartbeat(job.id).catch(() => undefined), Math.max(10_000, cfg.worker.staleJobMs / 5));
  try {
    const outcome = await runImportJob(job, {
      store,
      adapter,
      fetcher,
      extractText: extractTextNode,
      ocr: cfg.ocr.enabled ? createOcr(cfg.ocr) : undefined,
      maxDownloadsPerJob: Math.min(cfg.crawler.maxDownloadsPerJob, opts.maxDownloads ?? Infinity),
      maxItemAttempts: cfg.worker.maxItemAttempts,
      retryBaseMs: Math.max(5_000, cfg.crawler.delayMs * 4),
    });
    log("info", `Job ${job.id} finished: ${outcome} (${fetcher.requestCount} HTTP requests)`);
  } finally {
    clearInterval(beat);
  }
}

async function main() {
  log("info", `Worker starting (${once ? "single pass" : "polling"}); source ${cfg.source.baseUrl}`);
  await syncConfiguredCodes();
  while (!stopping) {
    const job = await claim().catch((err: Error) => {
      log("error", err.message);
      return null;
    });
    if (job) {
      await runOne(job);
      continue;
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, cfg.worker.pollIntervalMs));
  }
  log("info", "Worker stopped");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // The current job keeps its persisted state; another run resumes it after the stale timeout.
    log("warn", `${sig} received — stopping after the current step`);
    stopping = true;
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

main().catch((err) => {
  log("error", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
