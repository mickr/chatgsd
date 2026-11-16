import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(__dirname, "withdraw-release.sh");
const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const dirs: string[] = [];

interface GitHub {
  // Commit each tag points at; the lookup prefix-matches, as GitHub's does.
  tags?: Record<string, string>;
  tagLookupFails?: boolean;
  // The release list as GitHub pages it: one JSON array per page.
  pages?: object[][];
  releaseListFails?: boolean;
}

// Runs the script against a fake gh that serves `github` and records calls.
function withdraw(tag: string, github: GitHub) {
  const dir = mkdtempSync(join(tmpdir(), "withdraw-release-"));
  dirs.push(dir);
  const log = join(dir, "calls.log");
  const refs = Object.entries(github.tags ?? {}).map(([name, sha]) => ({
    ref: `refs/tags/${name}`,
    object: { sha },
  }));
  writeFileSync(join(dir, "refs.json"), JSON.stringify(refs));
  writeFileSync(join(dir, "pages.json"), (github.pages ?? []).map((page) => JSON.stringify(page)).join("\n"));
  const fail = 'echo "HTTP 502: Bad Gateway" >&2; exit 1';
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/bash
echo "$*" >> "${log}"
case "$*" in
  "api repos/owner/repo/git/matching-refs/"*) ${github.tagLookupFails ? fail : `cat "${dir}/refs.json"`} ;;
  "api --paginate "*) ${github.releaseListFails ? fail : `cat "${dir}/pages.json"`} ;;
esac
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(log, "");
  const run = spawnSync("bash", [script, tag, commit], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "owner/repo" },
  });
  const deletes = readFileSync(log, "utf8")
    .split("\n")
    .filter((call) => call.startsWith("api -X DELETE"))
    .map((call) => call.replace("api -X DELETE repos/owner/repo/", ""));
  return { status: run.status, deletes };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("withdraw-release.sh", () => {
  it("deletes nothing when the tag can't be looked up", () => {
    const result = withdraw("v1.2.3", { tagLookupFails: true });

    expect(result.status).not.toBe(0);
    expect(result.deletes).toEqual([]);
  });

  it("deletes nothing when the release list can't be read", () => {
    const result = withdraw("v1.2.3", { tags: { "v1.2.3": commit }, releaseListFails: true });

    expect(result.status).not.toBe(0);
    expect(result.deletes).toEqual([]);
  });

  it("leaves a version whose tag belongs to another commit's run", () => {
    const result = withdraw("v1.2.3", {
      tags: { "v1.2.3": otherCommit },
      pages: [[{ id: 2, tag_name: "v1.2.3", draft: true }]],
    });

    expect(result.status).toBe(0);
    expect(result.deletes).toEqual([]);
  });

  it("leaves a published release and its tag alone", () => {
    const result = withdraw("v1.2.3", {
      tags: { "v1.2.3": commit },
      pages: [[{ id: 7, tag_name: "v1.2.3", draft: false }]],
    });

    expect(result.status).toBe(0);
    expect(result.deletes).toEqual([]);
  });

  it("deletes the version's draft, found on a later page, then its tag", () => {
    const result = withdraw("v1.2.3", {
      tags: { "v1.2.3": commit, "v1.2.30": otherCommit },
      pages: [
        [{ id: 1, tag_name: "v1.2.2", draft: false }],
        [
          { id: 2, tag_name: "v1.2.3", draft: true },
          { id: 3, tag_name: "v1.2.30", draft: true },
        ],
      ],
    });

    expect(result.status).toBe(0);
    expect(result.deletes).toEqual(["releases/2", "git/refs/tags/v1.2.3"]);
  });

  it("deletes only the tag when the version has no release", () => {
    const result = withdraw("v1.2.3", {
      tags: { "v1.2.3": commit },
      pages: [[{ id: 1, tag_name: "v1.2.2", draft: false }]],
    });

    expect(result.status).toBe(0);
    expect(result.deletes).toEqual(["git/refs/tags/v1.2.3"]);
  });
});
