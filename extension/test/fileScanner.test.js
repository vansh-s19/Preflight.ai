// Checks that attachment parsers load only when a file needs them.
// Run: node extension/test/fileScanner.test.js
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

function loadScanner({ failFirst = false } = {}) {
  const requests = [];
  const context = vm.createContext({ console, Promise });
  context.globalThis = context;
  context.window = context;
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        requests.push(message.parser);
        if (failFirst && requests.length === 1) {
          setTimeout(() => callback({ success: false, error: "inject_failed" }), 0);
          return;
        }
        // Stand-in for chrome.scripting.executeScript defining the global.
        if (message.parser === "docx") {
          context.mammoth = { extractRawText: async () => ({ value: "PAN ABCDE1234F" }) };
        }
        if (message.parser === "pdf") {
          // A scan: one page whose only text is a page number.
          context.pdfjsLib = {
            GlobalWorkerOptions: { workerSrc: "pdf.worker.js" },
            getDocument: () => ({ promise: Promise.resolve({
              numPages: 1,
              getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "1" }] }) }),
            }) }),
          };
        }
        setTimeout(() => callback({ success: true }), 0);
      },
    },
  };
  vm.runInContext(readFileSync(join(__dirname, "..", "src", "fileScanner.js"), "utf8"), context);
  return { scanner: context.PreflightFileScanner, requests };
}

const file = (name, text = "") => ({
  name,
  text: async () => text,
  arrayBuffer: async () => new ArrayBuffer(8),
});

(async () => {
  {
    const { scanner, requests } = loadScanner();
    const txt = await scanner.extractFilesText([file("notes.txt", "hello")]);
    assert.match(txt.combinedText, /hello/);
    assert.deepEqual(requests, [], "plain text needs no parser");

    scanner.preload([file("a.docx"), file("b.docx")]);
    const docx = await scanner.extractFilesText([file("a.docx")]);
    assert.match(docx.combinedText, /ABCDE1234F/);
    assert.deepEqual(requests, ["docx"], "a parser is requested once, on first use");
  }

  {
    const { scanner, requests } = loadScanner({ failFirst: true });
    const first = await scanner.extractFilesText([file("a.docx")]);
    assert.equal(first.files[0].error, true, "a failed load reports the file as unreadable");
    const second = await scanner.extractFilesText([file("a.docx")]);
    assert.match(second.combinedText, /ABCDE1234F/, "the next attachment retries the load");
    assert.deepEqual(requests, ["docx", "docx"]);
  }

  {
    const { scanner } = loadScanner();
    const result = await scanner.extractFilesText([
      file("Scanned Document 5.pdf"),
      { ...file("pan-card.jpg"), type: "image/jpeg" },
      { ...file("clipboard"), type: "image/png" },
      file("notes.txt", "hello"),
      file("archive.zip"),
    ]);
    const status = Object.fromEntries(result.files.map((f) => [f.name, f.unreadable || (f.unsupported ? "unsupported" : "read")]));
    assert.deepEqual(status, {
      "Scanned Document 5.pdf": "scan",
      "pan-card.jpg": "image",
      clipboard: "image",
      "notes.txt": "read",
      "archive.zip": "unsupported",
    }, "scans and images are reported as unreadable");
    assert(!/pan-card|clipboard/.test(result.combinedText), "images add no text");
    assert(!/notes\.txt/.test(result.combinedText), "file names stay out of the scanned text");
  }

  console.log("fileScanner: all tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
