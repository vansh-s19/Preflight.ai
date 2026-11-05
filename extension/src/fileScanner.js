/**
 * fileScanner.js
 *
 * Extracts plain text from attached documents (PDF, DOCX, TXT) so their
 * content can be fed through the SAME Layer 1 / Layer 2 detection pipeline
 * used for typed prompt text (see content.js runScanAndDecide). This file
 * only extracts text — it does not scan, warn, sanitize, or log anything.
 *
 * Parsing runs entirely client-side using vendored pdf.js (src/vendor/pdf.min.js)
 * and mammoth.js (src/vendor/mammoth.browser.min.js). They are ~1 MB
 * together, so instead of loading on every page they are injected into
 * this content-script world by the background worker the first time a
 * file of that type is attached (see PREFLIGHT_LOAD_PARSER).
 */
(function () {
  const SUPPORTED_EXTENSIONS = ["pdf", "docx", "txt"];
  // Photos and screenshots: there is no text to read, so the user is asked
  // to check them instead (no on-device OCR yet).
  const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "bmp", "tif", "tiff"];
  // A PDF with less text than this (a page number, a stamp) is a scan.
  const MIN_READABLE_CHARS = 20;
  const PARSER_GLOBALS = { pdf: "pdfjsLib", docx: "mammoth" };
  const parserLoads = {};

  function extensionOf(fileName) {
    const parts = String(fileName || "").toLowerCase().split(".");
    return parts.length > 1 ? parts.pop() : "";
  }

  // Resolves once the parser's global exists. A failed load is forgotten so
  // the next attachment tries again.
  function loadParser(ext) {
    const globalName = PARSER_GLOBALS[ext];
    if (!globalName || typeof globalThis[globalName] !== "undefined") return Promise.resolve();
    if (!parserLoads[ext]) {
      parserLoads[ext] = new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "PREFLIGHT_LOAD_PARSER", parser: ext }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (!response || !response.success || typeof globalThis[globalName] === "undefined") {
            reject(new Error((response && response.error) || "parser_unavailable"));
          } else resolve();
        });
      }).catch((error) => {
        delete parserLoads[ext];
        throw error;
      });
    }
    return parserLoads[ext];
  }

  // Called as soon as files are picked, so the parser is usually ready by
  // the time the user presses send.
  function preload(files) {
    Array.from(files || []).forEach((file) => {
      loadParser(extensionOf(file.name)).catch(() => { /* retried at send time */ });
    });
  }

  function ensurePdfWorkerConfigured() {
    if (typeof pdfjsLib === "undefined") return;
    if (pdfjsLib.GlobalWorkerOptions.workerSrc) return;
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("src/vendor/pdf.worker.min.js");
  }

  async function extractPdfText(file) {
    ensurePdfWorkerConfigured();
    const buffer = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
    const pageTexts = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => item.str).join(" "));
    }
    return pageTexts.join("\n");
  }

  async function extractDocxText(file) {
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value || "";
  }

  async function extractTxtText(file) {
    return file.text();
  }

  async function extractOne(file) {
    const ext = extensionOf(file.name);
    try {
      await loadParser(ext);
      if (ext === "pdf" || ext === "docx") {
        const text = ext === "pdf" ? await extractPdfText(file) : await extractDocxText(file);
        // A Word file is only a "scan" if it has no text at all; a short one
        // can still be real text, like a single PAN number.
        const chars = text.replace(/\s+/g, "").length;
        const readable = ext === "pdf" ? chars >= MIN_READABLE_CHARS : chars > 0;
        return { name: file.name, text, unreadable: readable ? undefined : "scan" };
      }
      if (ext === "txt") return { name: file.name, text: await extractTxtText(file) };
      if (IMAGE_EXTENSIONS.includes(ext) || /^image\//.test(file.type || "")) {
        return { name: file.name, text: "", unreadable: "image" };
      }
      return { name: file.name, text: "", unsupported: true };
    } catch (error) {
      console.warn("[Preflight] failed to extract text from attachment", file.name, error);
      return { name: file.name, text: "", error: true, unreadable: "error" };
    }
  }

  // Returns { combinedText, files } where files reports per-attachment
  // status (name/unsupported/error/unreadable) WITHOUT its extracted text.
  // unreadable is "scan" (PDF/Word with no text layer), "image" or "error":
  // the file could not be checked, so the user should look at it themselves.
  // Callers must not log file names or content, only aggregate counts —
  // callers must not log file names or content, only aggregate counts.
  async function extractFilesText(files) {
    const results = await Promise.all(Array.from(files || []).map(extractOne));
    const combinedText = results
      .filter((r) => r.text && r.text.trim().length > 0)
      // No file name here: the text is scanned, and a name like
      // "report.pdf" would itself be flagged as a sensitive file type.
      .map((r, index) => `--- Attachment ${index + 1} ---\n${r.text}`)
      .join("\n\n");
    return {
      combinedText,
      files: results.map(({ name, unsupported, error, unreadable }) => ({ name, unsupported, error, unreadable })),
    };
  }

  window.PreflightFileScanner = { extractFilesText, preload, SUPPORTED_EXTENSIONS, IMAGE_EXTENSIONS };
})();
