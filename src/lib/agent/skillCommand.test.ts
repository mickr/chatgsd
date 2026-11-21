import { describe, expect, it } from "vitest";
import type { Skill } from "../../services/agent";
import { completeSkill, invokedSkill, matchSkills, skillQuery } from "./skillCommand";

const skill = (name: string, description = "", enabled = true): Skill => ({
  name, description, enabled, source: null, installedAt: 0, content: "", files: [], digest: null,
});
const skills = [
  skill("press-release", "Write launch announcements"),
  skill("release-notes", "Summarize changes for a version"),
  skill("outline", "Turn notes into a press outline"),
  skill("archived", "Old", false),
];

describe("invokedSkill", () => {
  it("names the enabled skill a message starts with, so the backend can load it", () => {
    expect(invokedSkill("/press-release the spring launch", skills)).toBe("press-release");
    expect(invokedSkill("/outline", skills)).toBe("outline");
    expect(invokedSkill("/outline\nthis section", skills)).toBe("outline");
  });

  it("leaves other slashes as text: a path, a prefix, a turned-off skill, or a mid-message mention", () => {
    expect(invokedSkill("/usr/local/bin is on PATH", skills)).toBeNull();
    expect(invokedSkill("/press tighten this", skills)).toBeNull();
    expect(invokedSkill("/archived run it", skills)).toBeNull();
    expect(invokedSkill("use /outline here", skills)).toBeNull();
    expect(invokedSkill("/outline", null)).toBeNull();
  });
});

describe("skillQuery", () => {
  it("completes only while the caret is inside the leading command", () => {
    expect(skillQuery("/", 1)).toBe("");
    expect(skillQuery("/pre", 4)).toBe("pre");
    expect(skillQuery("/pre the launch", 2)).toBe("pre");
    expect(skillQuery("/pre the launch", 8)).toBeNull();
    expect(skillQuery("/pre", 0)).toBeNull();
    expect(skillQuery("hello /pre", 10)).toBeNull();
  });
});

describe("matchSkills", () => {
  it("ranks name prefixes ahead of other matches and never offers a turned-off skill", () => {
    expect(matchSkills(skills, "").map((item) => item.name)).toEqual(["press-release", "release-notes", "outline"]);
    expect(matchSkills(skills, "rel").map((item) => item.name)).toEqual(["release-notes", "press-release"]);
    expect(matchSkills(skills, "PRESS").map((item) => item.name)).toEqual(["press-release", "outline"]);
    expect(matchSkills(skills, "arch")).toEqual([]);
  });
});

describe("completeSkill", () => {
  it("replaces only the command and keeps what the writer already typed after it", () => {
    expect(completeSkill("/pre", "press-release")).toEqual({ text: "/press-release ", caret: 15 });
    expect(completeSkill("/pre   the launch", "press-release")).toEqual({ text: "/press-release the launch", caret: 15 });
    expect(completeSkill("/pre\nthe launch", "press-release").text).toBe("/press-release \nthe launch");
  });
});
