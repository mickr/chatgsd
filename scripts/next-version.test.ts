import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(__dirname, "next-version.sh");
const isolated = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const repos: string[] = [];

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "next-version-"));
  repos.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: isolated });
  git("init", "-q");
  return {
    commit: () => git("commit", "-q", "--allow-empty", "-m", "change"),
    tag: (name: string) => git("tag", name),
    next: (bump: string) =>
      execFileSync("bash", [script, bump], { cwd: dir, env: isolated }).toString().trim(),
  };
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("next-version.sh", () => {
  it("bumps the highest release when one commit carries several tags", () => {
    const r = repo();
    r.commit();
    r.tag("v1.1.1");
    r.tag("v1.2.0");
    r.commit();

    expect(r.next("patch")).toBe("v1.2.0 1.2.1");
    expect(r.next("minor")).toBe("v1.2.0 1.3.0");
  });

  it("orders versions numerically and ignores tags that aren't releases", () => {
    const r = repo();
    r.commit();
    r.tag("v1.9.0");
    r.commit();
    r.tag("v1.10.0");
    r.commit();
    r.tag("v2.0.0-rc1");
    r.tag("v3");
    r.tag("latest");

    expect(r.next("patch")).toBe("v1.10.0 1.10.1");
    expect(r.next("major")).toBe("v1.10.0 2.0.0");
  });
});
