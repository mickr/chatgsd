import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSupportedTarget, hasExpectedHash, prepareCuaDriver } from "./prepare-cua-driver.mjs";

const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "prepare-cua-driver-"));
  roots.push(root);
  return root;
}

function supportedTarget() {
  vi.stubEnv("TAURI_ENV_PLATFORM", "darwin");
  vi.stubEnv("TAURI_ENV_ARCH", "aarch64");
  vi.stubEnv("TAURI_ENV_TARGET_TRIPLE", "aarch64-apple-darwin");
  vi.stubEnv("CARGO_BUILD_TARGET", "");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Cua Driver preparation", () => {

  it("rejects unsupported hosts and explicitly configured targets", () => {
    expect(() => assertSupportedTarget({}, "linux", "arm64")).toThrow("only bundled");
    expect(() => assertSupportedTarget({}, "darwin", "x64")).toThrow("only bundled");
    for (const variable of ["TAURI_ENV_TARGET_TRIPLE", "CARGO_BUILD_TARGET"]) {
      expect(() => assertSupportedTarget({ [variable]: "x86_64-apple-darwin" }, "darwin", "arm64")).toThrow("x86_64-apple-darwin");
    }
    expect(() => assertSupportedTarget({ TAURI_ENV_ARCH: "universal" }, "darwin", "arm64")).toThrow("universal");
  });

  it("hashes file contents instead of trusting a cached filename", async () => {
    const root = await temporaryRoot();
    const file = join(root, "cua-driver");
    const contents = "verified executable bytes";
    const expected = createHash("sha256").update(contents).digest("hex");
    await writeFile(file, contents);
    expect(await hasExpectedHash(file, expected)).toBe(true);
    await writeFile(file, "corrupt executable bytes");
    expect(await hasExpectedHash(file, expected)).toBe(false);
    expect(await hasExpectedHash(join(root, "missing"), expected)).toBe(false);
    expect(await hasExpectedHash(root, expected)).toBe(false);
  });

  it("rejects a cache entry that is a symlink, even to matching contents", async () => {
    const root = await temporaryRoot();
    const file = join(root, "source");
    const link = join(root, "cua-driver");
    await writeFile(file, "bytes");
    await symlink(file, link);
    const expected = createHash("sha256").update("bytes").digest("hex");
    expect(await hasExpectedHash(link, expected)).toBe(false);
  });

  it("refuses extraction of an unverified download and cleans staging without replacing old output", async () => {
    supportedTarget();
    const root = await temporaryRoot();
    const binaries = join(root, "src-tauri/binaries");
    const executable = join(binaries, "cua-driver-aarch64-apple-darwin");
    await mkdir(binaries, { recursive: true });
    await writeFile(executable, "corrupt cached executable");
    const download = vi.fn(async (path: string) => {
      await writeFile(path, "not the pinned archive");
    });

    await expect(prepareCuaDriver({ root, download })).rejects.toThrow("archive SHA-256 mismatch; refusing to extract");

    expect(download).toHaveBeenCalledOnce();
    expect(await readFile(executable, "utf8")).toBe("corrupt cached executable");
    expect(await readdir(binaries)).toEqual(["cua-driver-aarch64-apple-darwin"]);
  });

  it("rejects unsupported targets before downloading or creating output directories", async () => {
    supportedTarget();
    vi.stubEnv("TAURI_ENV_ARCH", "x86_64");
    const root = await temporaryRoot();
    const download = vi.fn();

    await expect(prepareCuaDriver({ root, download })).rejects.toThrow("only bundled");

    expect(download).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
