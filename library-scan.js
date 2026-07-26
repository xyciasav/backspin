"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".wave", ".m4a", ".mp4", ".aac", ".flac",
  ".ogg", ".oga", ".opus", ".aif", ".aiff", ".alac", ".wma"
]);

async function findAudioFiles(directory) {
  const results = [];
  const warnings = [];
  const pending = [directory];
  const visited = new Set();

  while (pending.length) {
    const current = pending.pop();
    let resolved;
    try {
      resolved = await fs.realpath(current);
      if (visited.has(resolved.toLowerCase())) continue;
      visited.add(resolved.toLowerCase());
    } catch (error) {
      warnings.push({ path: current, reason: error.code || "unavailable" });
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      warnings.push({ path: current, reason: error.code || "unreadable" });
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        pending.push(fullPath);
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
  return { paths: results, warnings };
}

function isAudioPath(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

module.exports = { AUDIO_EXTENSIONS, findAudioFiles, isAudioPath };
