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

  console.log("fileScanner: all tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
