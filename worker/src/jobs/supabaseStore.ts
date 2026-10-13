import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportItem, ItemStatus, ItemUpdate, JobPhase, JobStatus, JobStore, NewDiscoveredItem } from "./types";

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/** JobStore backed by Supabase (service role — runs only on the server). */
export class SupabaseJobStore implements JobStore {
  constructor(private readonly db: SupabaseClient) {}

  async heartbeat(jobId: string): Promise<JobStatus> {
    const row = check(
      await this.db.from("import_jobs").update({ heartbeat_at: new Date().toISOString() }).eq("id", jobId).select("status").single(),
      "heartbeat",
    );
    return (row as { status: JobStatus }).status;
  }

  async setPhase(jobId: string, phase: JobPhase) {
    check(await this.db.from("import_jobs").update({ phase }).eq("id", jobId), "setPhase");
  }

  async setPagesCrawled(jobId: string, pages: number) {
    check(await this.db.from("import_jobs").update({ pages_crawled: pages, heartbeat_at: new Date().toISOString() }).eq("id", jobId), "setPagesCrawled");
  }

  async insertDiscovered(jobId: string, items: NewDiscoveredItem[]) {
    if (items.length === 0) return 0;
    const rows = items.map((i) => ({ ...i, job_id: jobId, source: "import", status: "discovered" }));
    const data = check(
      await this.db.from("review_items").upsert(rows, { onConflict: "job_id,source_url", ignoreDuplicates: true }).select("id"),
      "insertDiscovered",
    );
    return (data ?? []).length;
  }

  async nextItems(jobId: string, limit: number, nowIso: string): Promise<ImportItem[]> {
    const data = check(
      await this.db
        .from("review_items")
        .select("id, job_id, status, source_url, link_text, original_filename, attempts")
        .eq("job_id", jobId)
        .or(`status.eq.discovered,and(status.eq.retry,next_attempt_at.lte.${nowIso})`)
        .order("discovery_priority", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(limit),
      "nextItems",
    );
    return data as ImportItem[];
  }

  async nextRetryAt(jobId: string) {
    const data = check(
      await this.db
        .from("review_items")
        .select("next_attempt_at")
        .eq("job_id", jobId)
        .eq("status", "retry")
        .order("next_attempt_at", { ascending: true })
        .limit(1),
      "nextRetryAt",
    ) as { next_attempt_at: string | null }[];
    return data[0]?.next_attempt_at ?? null;
  }

  async countDownloaded(jobId: string) {
    const res = await this.db.from("review_items").select("id", { count: "exact", head: true }).eq("job_id", jobId).not("sha256", "is", null);
    if (res.error) throw new Error(`countDownloaded: ${res.error.message}`);
    return res.count ?? 0;
  }

  async skipRemaining(jobId: string, reason: string) {
    const data = check(
      await this.db
        .from("review_items")
        .update({ status: "skipped", last_error: reason })
        .eq("job_id", jobId)
        .in("status", ["discovered", "retry"])
        .select("id"),
      "skipRemaining",
    );
    return (data ?? []).length;
  }

  async findPaperByHash(sha256: string) {
    const data = check(await this.db.from("papers").select("id").eq("sha256", sha256).maybeSingle(), "findPaperByHash") as { id: string } | null;
    return data?.id ?? null;
  }

  async findItemByHash(sha256: string, excludeId: string) {
    const data = check(
      await this.db
        .from("review_items")
        .select("id, status")
        .eq("sha256", sha256)
        .neq("id", excludeId)
        .in("status", ["pending_review", "unmatched", "rejected", "published"])
        .limit(1),
      "findItemByHash",
    ) as { id: string; status: ItemStatus }[];
    return data[0] ?? null;
  }

  async uploadStaging(sha256: string, bytes: Uint8Array) {
    const path = `import/${sha256}.pdf`;
    const { error } = await this.db.storage.from("staging").upload(path, bytes, { contentType: "application/pdf", upsert: true });
    if (error) throw new Error(`Staging upload failed: ${error.message}`);
    return path;
  }

  async updateItem(id: string, update: ItemUpdate) {
    const res = await this.db.from("review_items").update(update).eq("id", id);
    if (res.error) {
      // Unique violation on the open-queue hash index ⇒ the same file was queued concurrently.
      if (res.error.code === "23505" && update.sha256) {
        check(
          await this.db.from("review_items").update({ status: "duplicate", sha256: update.sha256, attempts: update.attempts, last_error: "Same file already in the review queue" }).eq("id", id),
          "updateItem(duplicate)",
        );
        return;
      }
      throw new Error(`updateItem: ${res.error.message}`);
    }
  }

  async log(jobId: string, level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) {
    const { error } = await this.db.from("import_job_logs").insert({ job_id: jobId, level, message: message.slice(0, 2000), context: context ?? null });
    if (error) console.error(`[log failed] ${error.message}`);
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[job ${jobId.slice(0, 8)}] ${message}`);
  }

  async finishJob(jobId: string, status: "completed" | "failed" | "cancelled", error?: string | null) {
    check(
      await this.db
        .from("import_jobs")
        .update({ status, error: error ?? null, finished_at: new Date().toISOString() })
        .eq("id", jobId)
        .neq("status", "cancelled"),
      "finishJob",
    );
  }
}
