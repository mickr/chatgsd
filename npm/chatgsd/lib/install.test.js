import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME, install, isNewer, swapIn } from "./install.js";

const cleanup = [];

afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

// Serves `body` for every request, the way a GitHub release download would.
async function serve(body) {
  const server = createServer((_, response) => response.end(body));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

describe("isNewer", () => {
  it("compares each part as a number", () => {
    expect(isNewer("1.1.10", "1.1.9")).toBe(true);
    expect(isNewer("1.2.0", "1.10.0")).toBe(false);
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.1.7", "1.1.7")).toBe(false);
  });
});

describe("install", () => {
  it("installs nothing and keeps the current app when the download doesn't match its checksum", async () => {
    const folder = mkdtempSync(join(tmpdir(), "chatgsd-install-"));
    cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
    mkdirSync(join(folder, APP_NAME));
    writeFileSync(join(folder, APP_NAME, "current"), "1.1.6");
    const base = await serve("not the published DMG");
    const release = { version: "1.1.7", dmg: "ChatGSD_1.1.7_aarch64.dmg", sha256: "0".repeat(64) };

    await expect(install(release, folder, base)).rejects.toThrow(/checksum/);

    expect(readFileSync(join(folder, APP_NAME, "current"), "utf8")).toBe("1.1.6");
    expect(existsSync(join(folder, `${APP_NAME}.installing`))).toBe(false);
  });
});

describe("swapIn", () => {
  it("puts the current app back when the new one can't be moved into place", () => {
    const folder = mkdtempSync(join(tmpdir(), "chatgsd-swap-"));
    cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
    const target = join(folder, APP_NAME);
    const incoming = `${target}.installing`;
    mkdirSync(target);
    writeFileSync(join(target, "current"), "1.1.6");
    mkdirSync(incoming);
    let moves = 0;
    const failSecondMove = (from, to) => {
      if (++moves === 2) throw new Error("rename failed");
      renameSync(from, to);
    };

    expect(() => swapIn(incoming, target, failSecondMove)).toThrow("rename failed");

    expect(readFileSync(join(target, "current"), "utf8")).toBe("1.1.6");
    expect(existsSync(`${target}.replaced`)).toBe(false);
  });
});
