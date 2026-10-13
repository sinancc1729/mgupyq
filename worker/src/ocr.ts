import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface OcrOptions {
  tesseractPath: string;
  pdftoppmPath: string;
  lang: string;
}

/**
 * OPTIONAL OCR of page 1 using poppler's `pdftoppm` + `tesseract`.
 * Only used when OCR_ENABLED=true and only for pages without readable text.
 * Results are labelled as OCR output in the review queue.
 */
export function createOcr(opts: OcrOptions) {
  return async (bytes: Uint8Array): Promise<string | null> => {
    const dir = await mkdtemp(path.join(tmpdir(), "mgu-ocr-"));
    try {
      const pdf = path.join(dir, "in.pdf");
      await writeFile(pdf, bytes);
      await run(opts.pdftoppmPath, ["-f", "1", "-l", "1", "-r", "200", "-png", pdf, path.join(dir, "page")], { timeout: 60_000 });
      const png = path.join(dir, "page-1.png");
      await run(opts.tesseractPath, [png, path.join(dir, "out"), "-l", opts.lang], { timeout: 120_000 });
      const text = await readFile(path.join(dir, "out.txt"), "utf8");
      return text.trim() ? text : null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
