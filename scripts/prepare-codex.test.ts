import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexTarget, hasExpectedHash, prepareCodex } from "./prepare-codex.mjs";

const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "prepare-codex-"));
  roots.push(root);
  return root;
}

function supportedTarget(target = "aarch64-apple-darwin") {
  vi.stubEnv("TAURI_ENV_PLATFORM", "macos");
  vi.stubEnv("TAURI_ENV_ARCH", target.startsWith("aarch64") ? "aarch64" : "x86_64");
  vi.stubEnv("TAURI_ENV_TARGET_TRIPLE", target);
  vi.stubEnv("CARGO_BUILD_TARGET", "");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex preparation", () => {
  it("selects native Apple Silicon and Intel binaries", () => {
    expect(codexTarget({}, "darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(codexTarget({}, "darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(codexTarget({ TAURI_ENV_PLATFORM: "macos", TAURI_ENV_ARCH: "aarch64" }, "linux", "x64")).toBe("aarch64-apple-darwin");
  });

  it("honors explicit cross-compilation targets rather than the build host", () => {
    for (const variable of ["TAURI_ENV_TARGET_TRIPLE", "CARGO_BUILD_TARGET"]) {
      expect(codexTarget({ [variable]: "x86_64-apple-darwin" }, "darwin", "arm64")).toBe("x86_64-apple-darwin");
    }
  });

  it("rejects unsupported platforms, triples, and universal builds", () => {
    expect(() => codexTarget({}, "linux", "arm64")).toThrow("only bundled for macOS");
    expect(() => codexTarget({ TAURI_ENV_TARGET_TRIPLE: "aarch64-unknown-linux-gnu" }, "darwin", "arm64")).toThrow("Unsupported Codex target");
    expect(() => codexTarget({}, "darwin", "universal")).toThrow("Unsupported Codex architecture");
  });

  it("validates contents and rejects symlink cache entries", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    const link = join(root, "link");
    const expected = createHash("sha256").update("verified bytes").digest("hex");
    await writeFile(source, "verified bytes");
    await symlink(source, link);
    expect(await hasExpectedHash(source, expected)).toBe(true);
    expect(await hasExpectedHash(link, expected)).toBe(false);
    expect(await hasExpectedHash(root, expected)).toBe(false);
    expect(await hasExpectedHash(join(root, "missing"), expected)).toBe(false);
    await writeFile(source, "corrupt bytes");
    expect(await hasExpectedHash(source, expected)).toBe(false);
  });

  it.each(["aarch64-apple-darwin", "x86_64-apple-darwin"])("refuses an unverified %s archive without replacing existing resources", async (target) => {
    supportedTarget(target);
    const root = await temporaryRoot();
    const resources = join(root, "src-tauri/resources");
    const output = join(resources, "codex");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "codex"), "previous binary");
    await writeFile(join(output, "codex-code-mode-host"), "previous tool host");
    await writeFile(join(output, "LICENSE"), "previous license");
    const download = vi.fn(async (path: string) => writeFile(path, "untrusted archive"));

    await expect(prepareCodex({ root, download })).rejects.toThrow("archive SHA-256 mismatch; refusing to extract");

    expect(download).toHaveBeenCalledExactlyOnceWith(expect.any(String), `https://github.com/openai/codex/releases/download/rust-v0.169.0/codex-${target}.tar.gz`);
    expect(await readFile(join(output, "codex"), "utf8")).toBe("previous binary");
    expect(await readFile(join(output, "codex-code-mode-host"), "utf8")).toBe("previous tool host");
    expect(await readFile(join(output, "LICENSE"), "utf8")).toBe("previous license");
    expect(await readdir(resources)).toEqual(["codex"]);
  });

  it("rejects unsupported targets before creating or downloading anything", async () => {
    supportedTarget("universal-apple-darwin");
    const root = await temporaryRoot();
    const download = vi.fn();

    await expect(prepareCodex({ root, download })).rejects.toThrow("Unsupported Codex target");

    expect(download).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
