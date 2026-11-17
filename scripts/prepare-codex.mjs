// Downloads official Codex release assets at build time, never running them.
// Archive digests are pinned from openai/codex's rust-v0.169.0 GitHub release
// asset metadata. Member and license digests were taken from those verified
// archives and the matching source tag. Updating Codex requires updating all.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const codexVersion = "0.169.0";
const releaseUrl = `https://github.com/openai/codex/releases/download/rust-v${codexVersion}`;
const sourceUrl = `https://raw.githubusercontent.com/openai/codex/rust-v${codexVersion}`;
const targets = {
  "aarch64-apple-darwin": {
    archiveSha256: "7f4c49c80bae1d0b4e347acfcdf11faa3475d87ae5e65a5eb1261d3c358145ee",
    binarySha256: "739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002",
  },
  "x86_64-apple-darwin": {
    archiveSha256: "6a2be05a75ecb88f92baf3e6988ce6efbe1d68341b68dac3ae505c4b8bbce475",
    binarySha256: "e57da7be8695c079d2d1d156dab79708e43ebb6cf7e34527b8b01d6aa942788e",
  },
};
const notices = [
  { name: "LICENSE", sha256: "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc" },
  { name: "NOTICE", sha256: "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915" },
];

export function codexTarget(env = process.env, platform = process.platform, arch = process.arch) {
  const configuredTarget = env.TAURI_ENV_TARGET_TRIPLE || env.CARGO_BUILD_TARGET;
  const configuredPlatform = env.TAURI_ENV_PLATFORM || platform;
  const configuredArch = env.TAURI_ENV_ARCH || arch;
  if (!["darwin", "macos"].includes(configuredPlatform)) {
    throw new Error(`Codex is only bundled for macOS; requested ${configuredPlatform}`);
  }
  if (configuredTarget) {
    if (!Object.hasOwn(targets, configuredTarget)) {
      throw new Error(`Unsupported Codex target: ${configuredTarget}`);
    }
    return configuredTarget;
  }
  if (["arm64", "aarch64"].includes(configuredArch)) return "aarch64-apple-darwin";
  if (["x64", "x86_64"].includes(configuredArch)) return "x86_64-apple-darwin";
  throw new Error(`Unsupported Codex architecture: ${configuredArch}`);
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

async function downloadFile(path, url) {
  await run("curl", [
    "--fail", "--location", "--silent", "--show-error",
    "--proto", "=https", "--proto-redir", "=https",
    "--output", path, url,
  ]);
}

export async function prepareCodex({ root = repoRoot, download = downloadFile } = {}) {
  const target = codexTarget();
  const pinned = targets[target];
  const resources = join(root, "src-tauri/resources");
  const destination = join(resources, "codex");
  const executable = join(destination, "codex");
  const files = [
    { name: "codex", sha256: pinned.binarySha256 },
    ...notices,
  ];
  const valid = await Promise.all(files.map((file) => hasExpectedHash(join(destination, file.name), file.sha256)));
  if (valid.every(Boolean)) {
    await chmod(executable, 0o755);
    return executable;
  }

  await mkdir(resources, { recursive: true });
  const stage = await mkdtemp(join(resources, ".codex-"));
  try {
    const archive = join(stage, "codex.tar.gz");
    await download(archive, `${releaseUrl}/codex-${target}.tar.gz`);
    if (!(await hasExpectedHash(archive, pinned.archiveSha256))) {
      throw new Error(`Codex ${codexVersion} archive SHA-256 mismatch; refusing to extract`);
    }
    await run("tar", ["-xzf", archive, "-C", stage, "--", `codex-${target}`]);
    await rename(join(stage, `codex-${target}`), join(stage, "codex"));
    await Promise.all(notices.map((file) => download(join(stage, file.name), `${sourceUrl}/${file.name}`)));
    for (const file of files) {
      if (!(await hasExpectedHash(join(stage, file.name), file.sha256))) {
        throw new Error(`Codex ${codexVersion}: invalid downloaded ${file.name}`);
      }
    }
    await chmod(join(stage, "codex"), 0o755);
    await mkdir(destination, { recursive: true });
    for (const file of files) {
      await rename(join(stage, file.name), join(destination, file.name));
    }
    return executable;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const executable = await prepareCodex();
    // Tauri signs externalBin, but not Mach-O files in bundle.resources. Sign
    // this verified resource before Tauri signs and notarizes the enclosing app.
    // A later preparation re-verifies the original bytes rather than trusting
    // a mutable signature or a cache marker left by the previous build.
    if (process.env.APPLE_SIGNING_IDENTITY) {
      await run("codesign", [
        "--force", "--options", "runtime", "--timestamp",
        "--sign", process.env.APPLE_SIGNING_IDENTITY, executable,
      ]);
    }
    console.log(`Codex ${codexVersion} ready: ${executable}`);
  } catch (error) {
    console.error(`Preparing Codex failed: ${error.message}`);
    process.exitCode = 1;
  }
}
