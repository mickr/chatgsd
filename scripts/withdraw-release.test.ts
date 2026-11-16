import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(__dirname, "withdraw-release.sh");
const dirs: string[] = [];

// Runs the script against a fake gh that records every call. The release
// list is served as GitHub pages it (one JSON array per page), or fails.
function withdraw(tag: string, list: { pages?: object[][]; fail?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "withdraw-release-"));
  dirs.push(dir);
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "pages.json"), (list.pages ?? []).map((page) => JSON.stringify(page)).join("\n"));
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/bash
echo "$*" >> "${log}"
if [ "$2" = "--paginate" ]; then
  ${list.fail ? 'echo "HTTP 502: Bad Gateway" >&2; exit 1' : `cat "${join(dir, "pages.json")}"`}
fi
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(log, "");
  const run = spawnSync("bash", [script, tag], {
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
  it("deletes nothing when the release list can't be read", () => {
    const result = withdraw("v1.2.3", { fail: true });

    expect(result.status).not.toBe(0);
    expect(result.deletes).toEqual([]);
  });

  it("leaves a published release and its tag alone", () => {
    const result = withdraw("v1.2.3", {
      pages: [[{ id: 7, tag_name: "v1.2.3", draft: false }]],
    });

    expect(result.status).toBe(0);
    expect(result.deletes).toEqual([]);
  });

  it("deletes the version's draft, found on a later page, then its tag", () => {
    const result = withdraw("v1.2.3", {
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
    const result = withdraw("v1.2.3", { pages: [[{ id: 1, tag_name: "v1.2.2", draft: false }]] });

    expect(result.status).toBe(0);
    expect(result.deletes).toEqual(["git/refs/tags/v1.2.3"]);
  });
});
