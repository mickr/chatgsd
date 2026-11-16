// Installs ChatGSD.app from the GitHub release this package was published with.
// The DMG must match the checksum pinned at publish time, and the app inside
// must carry a valid, notarized Developer ID signature from ChatGSD's team.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const APP_NAME = "ChatGSD.app";
export const TEAM_ID = "M9G92WURV3";
export const RELEASES = "https://github.com/mickr/chatgsd/releases/download";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

/** Whether version `a` is newer than `b` (MAJOR.MINOR.PATCH). */
export function isNewer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

/** The installed copy, preferring the system Applications folder. */
export function findApp(folders = ["/Applications", join(homedir(), "Applications")]) {
  return folders.map((folder) => join(folder, APP_NAME)).find((path) => existsSync(path)) ?? null;
}

export function appVersion(app) {
  const result = spawnSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents/Info.plist")], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function isRunning(app) {
  return spawnSync("pgrep", ["-f", join(app, "Contents/MacOS/")]).status === 0;
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Downloads the release DMG to `file` and checks it against the pinned checksum. */
export async function download(release, file, base = RELEASES) {
  const response = await fetch(`${base}/v${release.version}/${release.dmg}`);
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  const actual = await sha256(file);
  if (actual !== release.sha256) {
    throw new Error(`The download doesn't match the published checksum (${actual}), so nothing was installed`);
  }
}

function verifySignature(app) {
  run("codesign", ["--verify", "--deep", "--strict", app]);
  run("spctl", ["--assess", "--type", "execute", app]);
  const details = spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr;
  if (!details.includes(`TeamIdentifier=${TEAM_ID}`)) {
    throw new Error("The app isn't signed by ChatGSD's developer team, so nothing was installed");
  }
}

/**
 * Installs `release` into `folder`, replacing any copy there. The new app is
 * copied beside the old one and swapped in, so a failure leaves the old one.
 */
export async function install(release, folder, base = RELEASES) {
  const work = mkdtempSync(join(tmpdir(), "chatgsd-"));
  const mount = join(work, "mount");
  const target = join(folder, APP_NAME);
  const incoming = `${target}.installing`;
  let mounted = false;
  try {
    const dmg = join(work, release.dmg);
    await download(release, dmg, base);
    run("hdiutil", ["attach", "-quiet", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
    mounted = true;
    verifySignature(join(mount, APP_NAME));
    rmSync(incoming, { recursive: true, force: true });
    run("ditto", [join(mount, APP_NAME), incoming]);
    verifySignature(incoming);
    swapIn(incoming, target);
    return target;
  } finally {
    if (mounted) spawnSync("hdiutil", ["detach", "-quiet", mount]);
    rmSync(incoming, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Moves the verified `incoming` app to `target`. Any app already there is set
 * aside first and put back if the move fails, so a failure never leaves the
 * user without ChatGSD.
 */
export function swapIn(incoming, target, rename = renameSync) {
  const outgoing = `${target}.replaced`;
  // A run killed between the two moves left the user's app set aside.
  if (!existsSync(target) && existsSync(outgoing)) rename(outgoing, target);
  rmSync(outgoing, { recursive: true, force: true });
  const replacing = existsSync(target);
  if (replacing) rename(target, outgoing);
  try {
    rename(incoming, target);
  } catch (error) {
    if (replacing) rename(outgoing, target);
    throw error;
  }
  rmSync(outgoing, { recursive: true, force: true });
}
