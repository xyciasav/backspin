"use strict";

const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { findAudioFiles } = require("../library-scan");

(async () => {
  let musicFolder = path.join(os.homedir(), "Music");
  let temporaryFolder = null;
  const existing = await findAudioFiles(musicFolder);
  if (!existing.paths.length) {
    temporaryFolder = await fs.mkdtemp(path.join(os.tmpdir(), "backspin-import-"));
    musicFolder = temporaryFolder;
    await fs.writeFile(path.join(musicFolder, "Backspin Test.wav"), makeSilentWav());
  }
  const electronApp = await electron.launch({ args: [path.join(__dirname, "..")] });
  try {
    await electronApp.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, musicFolder);

    const window = await electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.locator("#addFolder").click();
    await window.waitForFunction(() => document.querySelectorAll("#trackList tr").length > 0, null, { timeout: 30000 });

    const result = await window.evaluate(() => ({
      rows: document.querySelectorAll("#trackList tr").length,
      count: document.querySelector("#trackCount")?.textContent,
      status: document.querySelector("#footerStatus")?.textContent,
      firstTitle: document.querySelector("#trackList .title")?.textContent
    }));
    if (!result.rows) throw new Error(`Import produced no rows: ${JSON.stringify(result)}`);
    console.log(JSON.stringify({ ok: true, ...result }));
  } finally {
    await electronApp.close();
    if (temporaryFolder) await fs.rm(temporaryFolder, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

function makeSilentWav() {
  const sampleRate = 8000;
  const sampleCount = sampleRate;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
