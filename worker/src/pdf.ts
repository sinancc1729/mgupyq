import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractFirstPageText, type PdfJsLike } from "../../shared/pdf/pageText";

/** Node-side first-page text extraction (pdfjs legacy build; no browser APIs needed). */
export function extractTextNode(bytes: Uint8Array) {
  return extractFirstPageText(pdfjs as unknown as PdfJsLike, bytes);
}
