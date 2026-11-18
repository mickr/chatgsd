import { describe, expect, it } from "vitest";
import { buildProjectTree, latestChange, leafName, shortPath } from "./projectTree";

const file = (id: string, modified = 0) => ({ id, modified });

describe("buildProjectTree", () => {
  it("nests files under their folders, creating parents that hold no files", () => {
    const tree = buildProjectTree([
      file("guides/setup/install"),
      file("guides/style"),
      file("readme"),
    ]);

    expect(tree.files.map((entry) => entry.id)).toEqual(["readme"]);
    expect(tree.folders.map((folder) => folder.path)).toEqual(["guides"]);
    const [guides] = tree.folders;
    expect(guides.files.map((entry) => entry.id)).toEqual(["guides/style"]);
    expect(guides.folders.map((folder) => [folder.name, folder.path])).toEqual([
      ["setup", "guides/setup"],
    ]);
    expect(guides.folders[0].files.map((entry) => entry.id)).toEqual(["guides/setup/install"]);
  });

  it("is an empty root for a folder with no markdown", () => {
    expect(buildProjectTree([])).toEqual({ name: "", path: "", folders: [], files: [] });
  });
});

describe("folder details", () => {
  it("reports the most recent change, or none for an empty folder", () => {
    expect(latestChange([file("a", 10), file("b", 30), file("c", 20)])).toBe(30);
    expect(latestChange([])).toBeNull();
  });

  it("names a file by the last part of its ID", () => {
    expect(leafName("guides/setup/install")).toBe("install");
    expect(leafName("readme")).toBe("readme");
  });

  it("writes the home folder as a tilde", () => {
    expect(shortPath("/Users/sam/code/app/docs")).toBe("~/code/app/docs");
    expect(shortPath("/Users/sam")).toBe("~");
    expect(shortPath("/Volumes/Work/docs")).toBe("/Volumes/Work/docs");
  });
});
