import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** A folder linked into a project from anywhere on this Mac. */
export interface ProjectFolder {
  /** Names the folder in file IDs; unique within its project. */
  label: string;
  path: string;
  /** Moved, deleted, or on a disconnected drive. */
  missing: boolean;
}
/** A named collection of linked folders. */
export interface Project {
  id: string;
  name: string;
  folders: ProjectFolder[];
}
export interface ProjectFile {
  /** Path relative to the linked folder, without `.md`. */
  id: string;
  /** Seconds since the Unix epoch. */
  modified: number;
}

const ID_PREFIX = "project:";

/** Whether an ID the agent gave names a project file rather than a note. */
export const isProjectFileId = (id: string) => id.startsWith(ID_PREFIX);

/** The ID the agent and `openFile` use for a file in a linked folder. */
export const projectFileId = (project: Project, folder: ProjectFolder, file: string) =>
  `${ID_PREFIX}${project.name}/${folder.label}/${file}`;

export const listProjects = () => invoke<Project[]>("projects_list");
export const createProject = (name: string) => invoke<void>("projects_create", { name });
export const renameProject = (id: string, name: string) =>
  invoke<void>("projects_rename", { id, name });
export const removeProject = (id: string) => invoke<void>("projects_remove", { id });
export const addFolder = (id: string, path: string) =>
  invoke<void>("projects_add_folder", { id, path });
export const removeFolder = (id: string, label: string) =>
  invoke<void>("projects_remove_folder", { id, label });
export const folderFiles = (id: string, label: string) =>
  invoke<ProjectFile[]>("projects_folder_files", { id, label });
/** Opens a project file in its own window. */
export const openFile = (id: string) => invoke<void>("projects_open_file", { id });

export const onProjectsChanged = (handler: (projects: Project[]) => void) =>
  listen<Project[]>("projects:changed", ({ payload }) => handler(payload));
