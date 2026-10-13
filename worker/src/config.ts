import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => (v == null ? undefined : /^(1|true|yes|on)$/i.test(v)));
const int = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SOURCE_BASE_URL: z.string().url().default("https://assist.mgu.ac.in/schema/"),
  SOURCE_ALLOWED_HOSTS: z.string().default("assist.mgu.ac.in"),
  SOURCE_PATH_PREFIX: z.string().default("/schema/"),
  CRAWLER_USER_AGENT: z.string().default("MGU-PYQ-Hub/1.0 (+https://github.com/your-org/mgu-pyq-hub)"),
  CRAWLER_DELAY_MS: int(1500),
  CRAWLER_TIMEOUT_MS: int(30000),
  CRAWLER_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  CRAWLER_MAX_PAGES: int(200),
  CRAWLER_MAX_DEPTH: int(4),
  CRAWLER_MAX_DOWNLOADS_PER_JOB: int(300),
  CRAWLER_RESPECT_ROBOTS: bool.default("true"),
  MAX_PDF_BYTES: int(25 * 1024 * 1024),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  WORKER_POLL_INTERVAL_MS: int(15000),
  WORKER_STALE_JOB_MS: int(300000),
  WORKER_MAX_ITEM_ATTEMPTS: int(3),
  TARGET_CODES_FILE: z.string().default("config/target-course-codes.json"),
  OCR_ENABLED: bool.default("false"),
  OCR_TESSERACT_PATH: z.string().default("tesseract"),
  OCR_PDFTOPPM_PATH: z.string().default("pdftoppm"),
  OCR_LANG: z.string().default("eng"),
});

export type WorkerEnv = z.infer<typeof schema>;

export interface WorkerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  source: { baseUrl: string; allowedHosts: string[]; pathPrefix: string };
  crawler: {
    userAgent: string;
    delayMs: number;
    timeoutMs: number;
    maxRetries: number;
    maxPages: number;
    maxDepth: number;
    maxDownloadsPerJob: number;
    respectRobots: boolean;
    maxPdfBytes: number;
  };
  worker: { id: string; pollIntervalMs: number; staleJobMs: number; maxItemAttempts: number };
  targetCodesFile: string;
  ocr: { enabled: boolean; tesseractPath: string; pdftoppmPath: string; lang: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid worker configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    supabaseUrl: e.SUPABASE_URL,
    serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    source: {
      baseUrl: e.SOURCE_BASE_URL,
      allowedHosts: e.SOURCE_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean),
      pathPrefix: e.SOURCE_PATH_PREFIX,
    },
    crawler: {
      userAgent: e.CRAWLER_USER_AGENT,
      delayMs: e.CRAWLER_DELAY_MS,
      timeoutMs: e.CRAWLER_TIMEOUT_MS,
      maxRetries: e.CRAWLER_MAX_RETRIES,
      maxPages: e.CRAWLER_MAX_PAGES,
      maxDepth: e.CRAWLER_MAX_DEPTH,
      maxDownloadsPerJob: e.CRAWLER_MAX_DOWNLOADS_PER_JOB,
      respectRobots: e.CRAWLER_RESPECT_ROBOTS ?? true,
      maxPdfBytes: e.MAX_PDF_BYTES,
    },
    worker: {
      id: e.WORKER_ID,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      staleJobMs: e.WORKER_STALE_JOB_MS,
      maxItemAttempts: e.WORKER_MAX_ITEM_ATTEMPTS,
    },
    targetCodesFile: e.TARGET_CODES_FILE,
    ocr: { enabled: e.OCR_ENABLED ?? false, tesseractPath: e.OCR_TESSERACT_PATH, pdftoppmPath: e.OCR_PDFTOPPM_PATH, lang: e.OCR_LANG },
  };
}

/** Reads config/target-course-codes.json. Returns [] when absent. */
export function readTargetCodesFile(file: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(path.resolve(file), "utf8")) as { codes?: unknown };
    return Array.isArray(raw.codes) ? raw.codes.map(String) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
