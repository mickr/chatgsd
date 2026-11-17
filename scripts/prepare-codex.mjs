// Downloads official Codex release assets at build time, never running them.
// Archive digests are pinned from openai/codex's rust-v0.169.0 GitHub release
// asset metadata. Member and license digests were taken from those verified
// archives and the matching source tag. Updating Codex requires updating all.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const codexVersion = "0.169.0";
const executableNames = ["codex", "codex-code-mode-host"];
const releaseUrl = `https://github.com/openai/codex/releases/download/rust-v${codexVersion}`;
const sourceUrl = `https://raw.githubusercontent.com/openai/codex/rust-v${codexVersion}`;
const targets = {
  "aarch64-apple-darwin": {
    archiveSha256: "7f4c49c80bae1d0b4e347acfcdf11faa3475d87ae5e65a5eb1261d3c358145ee",
    binarySha256: "739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002",
    hostArchiveSha256: "d40b320f6f256835d409472b7d3bee618a27549b3f3e1cb8b71dc6c56d3827bf",
    hostBinarySha256: "10feae2abe764bcf2273e241ace67aecc360eb8c28a82a2988bf1d8498a9bacf",
  },
  "x86_64-apple-darwin": {
    archiveSha256: "6a2be05a75ecb88f92baf3e6988ce6efbe1d68341b68dac3ae505c4b8bbce475",
    binarySha256: "e57da7be8695c079d2d1d156dab79708e43ebb6cf7e34527b8b01d6aa942788e",
    hostArchiveSha256: "2dd3285f242ea9cb130281089eee3604a95a4a751b1ddf25aa3929c2a488a79e",
    hostBinarySha256: "f03490828eb48754f722b14b0d39e7f6d3796293c72680390b2ca03af18dcdb1",
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
  const binaries = [
    { name: "codex", sha256: pinned.binarySha256, archiveSha256: pinned.archiveSha256 },
    { name: "codex-code-mode-host", sha256: pinned.hostBinarySha256, archiveSha256: pinned.hostArchiveSha256 },
  ];
  const files = [...binaries, ...notices];
  const valid = await Promise.all(files.map((file) => hasExpectedHash(join(destination, file.name), file.sha256)));
  if (valid.every(Boolean)) {
    await Promise.all(executableNames.map((name) => chmod(join(destination, name), 0o755)));
    return executable;
  }

  await mkdir(resources, { recursive: true });
  const stage = await mkdtemp(join(resources, ".codex-"));
  try {
    for (const binary of binaries) {
      const member = `${binary.name}-${target}`;
      const archive = join(stage, `${binary.name}.tar.gz`);
      await download(archive, `${releaseUrl}/${member}.tar.gz`);
      if (!(await hasExpectedHash(archive, binary.archiveSha256))) {
        throw new Error(`Codex ${codexVersion} ${binary.name} archive SHA-256 mismatch; refusing to extract`);
      }
      await run("tar", ["-xzf", archive, "-C", stage, "--", member]);
      await rename(join(stage, member), join(stage, binary.name));
    }
    await Promise.all(notices.map((file) => download(join(stage, file.name), `${sourceUrl}/${file.name}`)));
    for (const file of files) {
      if (!(await hasExpectedHash(join(stage, file.name), file.sha256))) {
        throw new Error(`Codex ${codexVersion}: invalid downloaded ${file.name}`);
      }
    }
    await Promise.all(executableNames.map((name) => chmod(join(stage, name), 0o755)));
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
    // both verified executables before Tauri signs and notarizes the enclosing app.
    // Keep the pinned host's JIT entitlements when replacing its signature.
    // A later preparation re-verifies the original bytes rather than trusting
    // a mutable signature or a cache marker left by the previous build.
    if (process.env.APPLE_SIGNING_IDENTITY) {
      for (const name of executableNames) {
        await run("codesign", [
          "--force", "--options", "runtime", "--timestamp",
          "--preserve-metadata=entitlements",
          "--sign", process.env.APPLE_SIGNING_IDENTITY, join(dirname(executable), name),
        ]);
      }
    }
    console.log(`Codex ${codexVersion} ready: ${executable}`);
  } catch (error) {
    console.error(`Preparing Codex failed: ${error.message}`);
    process.exitCode = 1;
  }
}
