import type { ExtractedPaperMetadata } from "../../../shared/types";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobPhase = "discover" | "process" | "done";
export type ItemStatus =
  | "discovered"
  | "retry"
  | "failed"
  | "skipped"
  | "duplicate"
  | "unmatched"
  | "pending_review"
  | "published"
  | "rejected";

export interface ImportJob {
  id: string;
  status: JobStatus;
  phase: JobPhase;
  keyword: string | null;
  course_codes: string[];
  options: Record<string, unknown>;
  attempts: number;
}

export interface ImportItem {
  id: string;
  job_id: string;
  status: ItemStatus;
  source_url: string;
  link_text: string | null;
  original_filename: string | null;
  attempts: number;
}

export interface NewDiscoveredItem {
  source_url: string;
  link_text: string;
  discovered_on: string;
  discovery_priority: number;
  original_filename: string;
}

export interface ItemUpdate {
  status: ItemStatus;
  attempts?: number;
  next_attempt_at?: string | null;
  last_error?: string | null;
  sha256?: string;
  size_bytes?: number;
  staging_path?: string;
  first_page_text?: string;
  extracted?: ExtractedPaperMetadata;
  match_status?: ExtractedPaperMetadata["codeMatch"]["status"];
  confidence?: number;
  warnings?: string[];
  course_code?: string | null;
  course_title?: string | null;
  department_name?: string | null;
  semester?: number | null;
  course_type?: string | null;
  kind?: string | null;
  exam_month?: number | null;
  exam_year?: number | null;
  duplicate_of_paper_id?: string | null;
}

/** Persistence used by the job runner. Implemented for Supabase and in-memory (tests). */
export interface JobStore {
  /** Updates the heartbeat and returns the job's current status (detects cancellation). */
  heartbeat(jobId: string): Promise<JobStatus>;
  setPhase(jobId: string, phase: JobPhase): Promise<void>;
  setPagesCrawled(jobId: string, pages: number): Promise<void>;
  /** Inserts discovered links; existing (job_id, source_url) rows are left untouched. Returns rows inserted. */
  insertDiscovered(jobId: string, items: NewDiscoveredItem[]): Promise<number>;
  /** Items ready to process now (discovered, or retry whose backoff has elapsed), most relevant first. */
  nextItems(jobId: string, limit: number, nowIso: string): Promise<ImportItem[]>;
  /** Earliest next_attempt_at among retry items, or null when nothing is waiting. */
  nextRetryAt(jobId: string): Promise<string | null>;
  /** Number of items in this job that have already been downloaded (for the per-job limit on resume). */
  countDownloaded(jobId: string): Promise<number>;
  skipRemaining(jobId: string, reason: string): Promise<number>;
  findPaperByHash(sha256: string): Promise<string | null>;
  /** Another review item with the same hash that is queued, rejected or published. */
  findItemByHash(sha256: string, excludeId: string): Promise<{ id: string; status: ItemStatus } | null>;
  uploadStaging(sha256: string, bytes: Uint8Array): Promise<string>;
  updateItem(id: string, update: ItemUpdate): Promise<void>;
  log(jobId: string, level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): Promise<void>;
  finishJob(jobId: string, status: Exclude<JobStatus, "queued" | "running">, error?: string | null): Promise<void>;
}
