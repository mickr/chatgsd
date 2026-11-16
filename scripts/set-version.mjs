// Writes an app version into every file that declares one, changing nothing
// else. The release workflow runs it in its own checkout; versions live in
// tags, not commits.
//
//   node scripts/set-version.mjs 1.2.3
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(2);
}

const topLevelJson = /^(  "version": ")[^"]*"/m;
const files = {
  "package.json": [topLevelJson],
  "package-lock.json": [topLevelJson, /("packages": \{\n    "": \{\n      "name": "[^"]*",\n      "version": ")[^"]*"/],
  "src-tauri/tauri.conf.json": [topLevelJson],
  "src-tauri/Cargo.toml": [/(\[package\][^[]*?\nversion = ")[^"]*"/],
  "src-tauri/Cargo.lock": [/(\[\[package\]\]\nname = "Scratch"\nversion = ")[^"]*"/],
};

for (const [path, patterns] of Object.entries(files)) {
  let text = readFileSync(path, "utf8");
  for (const pattern of patterns) {
    if (!pattern.test(text)) throw new Error(`No version found in ${path}`);
    text = text.replace(pattern, (_, start) => `${start}${version}"`);
  }
  writeFileSync(path, text);
}
console.log(`Version set to ${version}`);
