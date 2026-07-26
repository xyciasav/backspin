"use strict";

const { _electron: electron } = require("playwright");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const musicFolder = path.join(os.homedir(), "Music");
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
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
