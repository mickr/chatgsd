import type { ProjectFile } from "../services/projects";

/** A folder inside a linked folder, with the markdown files directly in it. */
export interface ProjectTreeNode {
  name: string;
  /** Path relative to the linked folder; empty for the linked folder itself. */
  path: string;
  folders: ProjectTreeNode[];
  files: ProjectFile[];
}

/** Arranges a linked folder's files, which arrive ordered by ID, as a tree. */
export function buildProjectTree(files: ProjectFile[]): ProjectTreeNode {
  const root: ProjectTreeNode = { name: "", path: "", folders: [], files: [] };
  const nodes = new Map<string, ProjectTreeNode>([["", root]]);
  const folder = (path: string): ProjectTreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const cut = path.lastIndexOf("/");
    const node = { name: path.slice(cut + 1), path, folders: [], files: [] };
    nodes.set(path, node);
    folder(cut < 0 ? "" : path.slice(0, cut)).folders.push(node);
    return node;
  };
  for (const file of files) {
    const cut = file.id.lastIndexOf("/");
    folder(cut < 0 ? "" : file.id.slice(0, cut)).files.push(file);
  }
  return root;
}

/** When the most recently changed file was changed, in seconds, if there is one. */
export const latestChange = (files: ProjectFile[]): number | null =>
  files.length ? Math.max(...files.map((file) => file.modified)) : null;

/** The last part of a file ID or path. */
export const leafName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A path with the home folder written as `~`. */
export const shortPath = (path: string) => path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
