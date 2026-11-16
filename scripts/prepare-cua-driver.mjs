// Prepares the pinned macOS sidecar, never executing downloaded code. Paths are
// relative to this script, so Tauri hooks can run from any working directory.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const version = "0.38.0";
const target = "aarch64-apple-darwin";
const archiveRoot = `cua-driver-rs-${version}-darwin-arm64`;
const archiveUrl = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${archiveRoot}.tar.gz`;
const archiveSha256 = "5f71191c082ca07c9dfc13b7c9a6eec60a82818c245a93534cc0eb7911471d72";
// These hashes come from the checksum-verified release archive. Checking the
// prepared files too makes the on-disk cache safe without retaining the archive.
const files = [
  {
    member: "cua-driver",
    output: `src-tauri/binaries/cua-driver-${target}`,
    sha256: "92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f",
  },
  {
    member: "LICENSE",
    output: "src-tauri/resources/cua-driver/LICENSE",
    sha256: "c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9",
  },
  {
    member: "THIRD_PARTY_NOTICES.md",
    output: "src-tauri/resources/cua-driver/THIRD_PARTY_NOTICES.md",
    sha256: "82470c85cb48dd084fccbf192d4a9f0b9d0afe614ab9b63e0fceac0eb315f412",
  },
];

export function assertSupportedTarget(env = process.env, platform = process.platform, arch = process.arch) {
  const configuredTarget = env.TAURI_ENV_TARGET_TRIPLE || env.CARGO_BUILD_TARGET;
  const configuredPlatform = env.TAURI_ENV_PLATFORM || platform;
  const configuredArch = env.TAURI_ENV_ARCH || arch;
  if (
    (configuredTarget && configuredTarget !== target) ||
    !["darwin", "macos"].includes(configuredPlatform) ||
    !["arm64", "aarch64"].includes(configuredArch)
  ) {
    throw new Error(`Cua Driver is only bundled for ${target}; requested ${configuredTarget || `${configuredPlatform}/${configuredArch}`}`);
  }
}

export async function hasExpectedHash(path, expected) {
  try {
    if (!(await lstat(path)).isFile()) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === expected;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function downloadArchive(path) {
  await run("curl", [
    "--fail", "--location", "--silent", "--show-error",
    "--proto", "=https", "--proto-redir", "=https",
    "--output", path, archiveUrl,
  ]);
}

export async function prepareCuaDriver({ root = repoRoot, download = downloadArchive } = {}) {
  assertSupportedTarget();
  const executable = join(root, files[0].output);
  const valid = await Promise.all(files.map((file) => hasExpectedHash(join(root, file.output), file.sha256)));
  if (valid.every(Boolean)) {
    await chmod(executable, 0o755);
    return executable;
  }

  // Keep staging on the destination filesystem so publication is an atomic
  // rename per file, including when an old output was a symlink or corrupt.
  const binaries = join(root, "src-tauri/binaries");
  await mkdir(binaries, { recursive: true });
  const stage = await mkdtemp(join(binaries, ".cua-driver-"));
  try {
    const archive = join(stage, "driver.tar.gz");
    await download(archive);
    if (!(await hasExpectedHash(archive, archiveSha256))) {
      throw new Error(`Cua Driver ${version} archive SHA-256 mismatch; refusing to extract`);
    }
    await run("tar", [
      "-xzf", archive, "-C", stage, "--",
      ...files.map((file) => `${archiveRoot}/${file.member}`),
    ]);
    for (const file of files) {
      if (!(await hasExpectedHash(join(stage, archiveRoot, file.member), file.sha256))) {
        throw new Error(`Cua Driver ${version}: invalid extracted ${file.member}`);
      }
    }
    await chmod(join(stage, archiveRoot, "cua-driver"), 0o755);
    for (const file of files) {
      const destination = join(root, file.output);
      await mkdir(dirname(destination), { recursive: true });
      await rename(join(stage, archiveRoot, file.member), destination);
    }
    return executable;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const executable = await prepareCuaDriver();
    console.log(`Cua Driver ${version} ready: ${executable}`);
  } catch (error) {
    console.error(`Preparing Cua Driver failed: ${error.message}`);
    process.exitCode = 1;
  }
}
