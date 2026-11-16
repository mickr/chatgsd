#!/usr/bin/env node
// npx chatgsd [files...]: installs or updates ChatGSD.app, then opens it.
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appVersion, findApp, install, isNewer, isRunning } from "../lib/install.js";

const release = JSON.parse(readFileSync(new URL("../release.json", import.meta.url), "utf8"));
const files = process.argv.slice(2);

if (files.includes("--help") || files.includes("-h")) {
  console.log("Usage: npx chatgsd [file.md ...]\n\nInstalls or updates ChatGSD, then opens it (and any files given).");
  process.exit(0);
}
if (files.includes("--version") || files.includes("-v")) {
  console.log(release.version);
  process.exit(0);
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("ChatGSD is available for Apple Silicon Macs.");
  process.exit(1);
}

// An update goes where the app already is. A new install goes to
// /Applications when this user can write there, otherwise ~/Applications.
function installFolder(app) {
  if (app) return dirname(app);
  try {
    accessSync("/Applications", constants.W_OK);
    return "/Applications";
  } catch {
    const own = join(homedir(), "Applications");
    mkdirSync(own, { recursive: true });
    return own;
  }
}

async function main() {
  let app = findApp();
  const installed = app && appVersion(app);
  if (!app || !installed || isNewer(release.version, installed)) {
    if (app && isRunning(app)) {
      console.log(`ChatGSD ${installed} is running; it updates itself, or quit it and run this again for ${release.version}.`);
    } else {
      console.log(installed ? `Updating ChatGSD ${installed} to ${release.version}...` : `Installing ChatGSD ${release.version}...`);
      app = await install(release, installFolder(app));
      console.log(`Installed ${app}`);
    }
  }
  const opened = spawnSync("open", ["-a", app, ...files], { stdio: "inherit" });
  process.exit(opened.status ?? 1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
