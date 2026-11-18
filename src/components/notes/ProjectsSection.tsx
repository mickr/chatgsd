import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import * as projectsService from "../../services/projects";
import type { Project, ProjectFile, ProjectFolder } from "../../services/projects";
import { errorMessage } from "../../services/agent";
import {
  buildProjectTree,
  latestChange,
  leafName,
  shortPath,
  type ProjectTreeNode,
} from "../../lib/projectTree";
import { formatDate } from "../../lib/utils";
import { IconButton } from "../ui";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  NoteIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon,
} from "../icons";
import { FolderNameDialog } from "./FolderNameDialog";

const TOGGLED_KEY = "scratch:projectsToggled";
const SECTION_KEY = "scratch:projectsCollapsed";
const HEIGHT_KEY = "scratch:projectsHeight";
const MIN_HEIGHT_PX = 96;
/** The most of the sidebar the section may take, leaving the notes list in view. */
const MAX_HEIGHT_SHARE = 0.75;
/** Pointer movement below this many px counts as a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

const menuItemClass =
  "px-3 py-1.5 text-sm text-text cursor-pointer outline-none hover:bg-bg-muted focus:bg-bg-muted flex items-center gap-2 rounded-sm";
const menuContentClass =
  "min-w-44 bg-bg border border-border rounded-md shadow-lg py-1 z-50";
const menuSeparatorClass = "h-px bg-border my-1";
const rowClass =
  "flex items-center gap-1.5 py-1.5 cursor-pointer rounded-md select-none transition-colors hover:bg-bg-muted";
const chevronClass = "w-4 h-4 stroke-[1.6] text-text-muted/60 shrink-0";

/** A linked folder's files, or why they couldn't be read; absent while loading. */
type FolderFiles = ProjectFile[] | { error: string };

const folderKey = (project: Project, folder: ProjectFolder) =>
  `${project.id}|${folder.path}`;

function loadToggled(): Set<string> {
  try {
    const saved = localStorage.getItem(TOGGLED_KEY);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch {
    return new Set();
  }
}

/** The height the user dragged the section to; `null` sizes it to its content. */
function loadHeight(): number | null {
  try {
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  } catch {
    return null;
  }
}

function saveHeight(height: number | null) {
  try {
    if (height === null) localStorage.removeItem(HEIGHT_KEY);
    else localStorage.setItem(HEIGHT_KEY, String(height));
  } catch {
    // Ignore localStorage errors
  }
}

interface ResizeHandleProps {
  height: number | null;
  /** Shows a height while dragging, without saving it. */
  onResize: (height: number | null) => void;
  /** Keeps a height, or `null` to size the section to its content again. */
  onCommit: (height: number | null) => void;
}

/**
 * Drag handle on the section's top edge. Drag to resize, use the arrow keys
 * (Shift for a larger step), or double-click to fit the content again.
 */
function ResizeHandle({ height, onResize, onCommit }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; initial: number; moved: boolean } | null>(null);

  // The section, and the sidebar it shares with the notes list.
  const bounds = (handle: HTMLElement) => {
    const section = handle.parentElement!;
    const available = section.parentElement!.clientHeight * MAX_HEIGHT_SHARE;
    return {
      current: section.offsetHeight,
      clamp: (px: number) => Math.round(Math.max(MIN_HEIGHT_PX, Math.min(px, available))),
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      startY: event.clientY,
      initial: bounds(event.currentTarget).current,
      moved: false,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = event.clientY - drag.current.startY;
    if (!drag.current.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
    drag.current.moved = true;
    // The handle is the top edge, so dragging up makes the section taller.
    onResize(bounds(event.currentTarget).clamp(drag.current.initial - delta));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    // A stationary click keeps the section as it was, so a double-click can reset it.
    if (drag.current.moved) onCommit(height);
    drag.current = null;
    setDragging(false);
  };

  const handlePointerCancel = () => {
    if (!drag.current) return;
    onResize(loadHeight());
    drag.current = null;
    setDragging(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = (event.shiftKey ? 64 : 16) * (event.key === "ArrowUp" ? 1 : -1);
    const { current, clamp } = bounds(event.currentTarget);
    onCommit(clamp(current + step));
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize projects"
      aria-valuenow={height ?? undefined}
      aria-valuemin={MIN_HEIGHT_PX}
      tabIndex={0}
      className="group absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize outline-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={() => onCommit(null)}
      onKeyDown={handleKeyDown}
    >
      <div
        className={`absolute inset-x-0 top-1/2 h-0.75 -translate-y-1/2 rounded-full bg-border transition-opacity duration-150 ${
          dragging
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
      />
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDownIcon className={chevronClass} />
  ) : (
    <ChevronRightIcon className={chevronClass} />
  );
}

interface TreeProps {
  node: ProjectTreeNode;
  depth: number;
  /** Prefixes this linked folder's keys in the toggled set. */
  scope: string;
  toggled: Set<string>;
  onToggle: (key: string) => void;
  onOpenFile: (file: string) => void;
}

/** The subfolders and markdown files directly inside one folder. */
function TreeContents({ node, depth, scope, toggled, onToggle, onOpenFile }: TreeProps) {
  const indent = { paddingLeft: `${depth * 12 + 8}px`, paddingRight: "8px" };
  return (
    <>
      {node.folders.map((child) => {
        const key = `${scope}|${child.path}`;
        const expanded = toggled.has(key);
        return (
          <div key={child.path} className="flex flex-col gap-0.5">
            <div
              className={rowClass}
              style={indent}
              onClick={() => onToggle(key)}
              role="button"
              tabIndex={-1}
            >
              <Chevron open={expanded} />
              <span className="text-sm text-text-muted truncate">{child.name}</span>
            </div>
            {expanded && (
              <TreeContents
                node={child}
                depth={depth + 1}
                scope={scope}
                toggled={toggled}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        );
      })}
      {node.files.map((file) => (
        <div
          key={file.id}
          className={rowClass}
          style={indent}
          onClick={() => onOpenFile(file.id)}
          title={`Changed ${formatDate(file.modified)}`}
          role="button"
          tabIndex={-1}
        >
          <NoteIcon className="w-4 h-4 stroke-[1.6] opacity-50 shrink-0" />
          <span className="text-sm text-text truncate">{leafName(file.id)}</span>
        </div>
      ))}
    </>
  );
}

/** Where the folder lives and what it holds, under its name. */
function folderDetail(folder: ProjectFolder, files: FolderFiles | undefined): string {
  const place = shortPath(folder.path);
  if (folder.missing) return `Not found · ${place}`;
  if (!files) return `Reading… · ${place}`;
  if (!Array.isArray(files)) return files.error;
  const changed = latestChange(files);
  return changed === null
    ? `No markdown files · ${place}`
    : `Changed ${formatDate(changed)} · ${place}`;
}

interface LinkedFolderProps {
  project: Project;
  folder: ProjectFolder;
  files: FolderFiles | undefined;
  toggled: Set<string>;
  onToggle: (key: string) => void;
  onRefresh: (project: Project, folder: ProjectFolder) => void;
}

const LinkedFolder = memo(function LinkedFolder({
  project,
  folder,
  files,
  toggled,
  onToggle,
  onRefresh,
}: LinkedFolderProps) {
  const key = folderKey(project, folder);
  const expanded = toggled.has(key);
  const listed = Array.isArray(files) ? files : null;
  const tree = useMemo(() => (listed ? buildProjectTree(listed) : null), [listed]);

  const handleToggle = useCallback(() => {
    if (!expanded) onRefresh(project, folder);
    onToggle(key);
  }, [expanded, folder, key, onRefresh, onToggle, project]);

  const handleOpenFile = useCallback(
    (file: string) => {
      projectsService
        .openFile(projectsService.projectFileId(project, folder, file))
        .catch((error) => toast.error(errorMessage(error)));
    },
    [folder, project],
  );

  const handleShow = useCallback(() => {
    invoke("open_in_file_manager", { path: folder.path }).catch((error) =>
      toast.error(errorMessage(error)),
    );
  }, [folder.path]);

  const handleRemove = useCallback(() => {
    projectsService
      .removeFolder(project.id, folder.label)
      .catch((error) => toast.error(errorMessage(error)));
  }, [folder.label, project.id]);

  return (
    <div className="flex flex-col gap-0.5">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className={`${rowClass} items-start`}
            style={{ paddingLeft: "20px", paddingRight: "8px" }}
            onClick={handleToggle}
            title={folder.path}
            role="button"
            tabIndex={-1}
          >
            <span className="mt-0.5">
              <Chevron open={expanded} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <FolderIcon className="w-4 h-4 stroke-[1.6] opacity-50 shrink-0" />
                <span className="text-sm text-text truncate">{folder.label}</span>
                {listed && (
                  <span className="ml-auto shrink-0 text-2xs font-medium text-text-muted">
                    {listed.length}
                  </span>
                )}
              </div>
              <div
                className={`text-2xs truncate ${folder.missing ? "text-red-500" : "text-text-muted"}`}
              >
                {folderDetail(folder, files)}
              </div>
            </div>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={menuContentClass}>
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={handleShow}
              disabled={folder.missing}
            >
              <FolderIcon className="w-4 h-4 stroke-[1.6]" />
              Show in Finder
            </ContextMenu.Item>
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={() => onRefresh(project, folder)}
            >
              <RefreshCwIcon className="w-4 h-4 stroke-[1.6]" />
              Refresh
            </ContextMenu.Item>
            <ContextMenu.Separator className={menuSeparatorClass} />
            <ContextMenu.Item className={menuItemClass} onSelect={handleRemove}>
              <TrashIcon className="w-4 h-4 stroke-[1.6]" />
              Remove from Project
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {expanded && tree && (
        <TreeContents
          node={tree}
          depth={3}
          scope={key}
          toggled={toggled}
          onToggle={onToggle}
          onOpenFile={handleOpenFile}
        />
      )}
    </div>
  );
});

interface ProjectItemProps {
  project: Project;
  files: Record<string, FolderFiles>;
  toggled: Set<string>;
  onToggle: (key: string) => void;
  onAddFolders: (project: Project) => void;
  onRename: (project: Project) => void;
  onRefresh: (project: Project, folder: ProjectFolder) => void;
}

const ProjectItem = memo(function ProjectItem({
  project,
  files,
  toggled,
  onToggle,
  onAddFolders,
  onRename,
  onRefresh,
}: ProjectItemProps) {
  // Projects start open; linked folders and their subfolders start closed.
  const expanded = !toggled.has(project.id);

  const handleRemove = useCallback(() => {
    projectsService
      .removeProject(project.id)
      .then(() => toast.success(`Removed ${project.name}. Its folders are unchanged.`))
      .catch((error) => toast.error(errorMessage(error)));
  }, [project.id, project.name]);

  return (
    <div className="flex flex-col gap-0.5">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className={`${rowClass} group pl-2 pr-1`}
            onClick={() => onToggle(project.id)}
            role="button"
            tabIndex={-1}
          >
            <Chevron open={expanded} />
            <span className="text-sm font-medium text-text truncate flex-1">
              {project.name}
            </span>
            <IconButton
              size="xs"
              title="Add Folders"
              className="opacity-0 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onAddFolders(project);
              }}
            >
              <FolderPlusIcon className="w-4 h-4 stroke-[1.6]" />
            </IconButton>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={menuContentClass}>
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={() => onAddFolders(project)}
            >
              <FolderPlusIcon className="w-4 h-4 stroke-[1.6]" />
              Add Folders…
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItemClass} onSelect={() => onRename(project)}>
              <PencilIcon className="w-4 h-4 stroke-[1.6]" />
              Rename…
            </ContextMenu.Item>
            <ContextMenu.Separator className={menuSeparatorClass} />
            <ContextMenu.Item className={menuItemClass} onSelect={handleRemove}>
              <TrashIcon className="w-4 h-4 stroke-[1.6]" />
              Remove Project
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {expanded &&
        project.folders.map((folder) => (
          <LinkedFolder
            key={folder.path}
            project={project}
            folder={folder}
            files={files[folderKey(project, folder)]}
            toggled={toggled}
            onToggle={onToggle}
            onRefresh={onRefresh}
          />
        ))}
      {expanded && project.folders.length === 0 && (
        <button
          type="button"
          className="text-left text-sm text-text-muted/70 hover:text-text py-1 cursor-pointer"
          style={{ paddingLeft: "28px" }}
          onClick={() => onAddFolders(project)}
        >
          Add folders…
        </button>
      )}
    </div>
  );
});

/**
 * Projects in the sidebar: collections of folders linked from anywhere on
 * this Mac. Each folder shows where it lives, how many markdown files it
 * holds and when one last changed; its files open in their own window. The
 * agent reads the same folders through `list_projects` and `search_projects`.
 * The section sizes to its content until its top edge is dragged.
 */
export function ProjectsSection() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [files, setFiles] = useState<Record<string, FolderFiles>>({});
  const [toggled, setToggled] = useState(loadToggled);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SECTION_KEY) === "true",
  );
  const [height, setHeight] = useState(loadHeight);
  const [naming, setNaming] = useState<{ project: Project | null } | null>(null);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // Listen before loading, so a change during the load isn't lost.
    void projectsService
      .onProjectsChanged(setProjects)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {})
      .then(() => projectsService.listProjects())
      .then((loaded) => {
        if (!disposed) setProjects((current) => current ?? loaded);
      })
      .catch((error) => toast.error(errorMessage(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const readFolder = useCallback((project: Project, folder: ProjectFolder) => {
    const key = folderKey(project, folder);
    projectsService
      .folderFiles(project.id, folder.label)
      .then((listed): FolderFiles => listed)
      .catch((error): FolderFiles => ({ error: errorMessage(error) }))
      .then((result) => setFiles((current) => ({ ...current, [key]: result })));
  }, []);

  // Read each linked folder once, so its details show before it is opened.
  useEffect(() => {
    for (const project of projects ?? []) {
      for (const folder of project.folders) {
        const key = folderKey(project, folder);
        if (folder.missing || requested.current.has(key)) continue;
        requested.current.add(key);
        readFolder(project, folder);
      }
    }
  }, [projects, readFolder]);

  const handleToggle = useCallback((key: string) => {
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(TOGGLED_KEY, JSON.stringify([...next]));
      } catch {
        // Ignore localStorage errors
      }
      return next;
    });
  }, []);

  const handleCollapse = useCallback(() => {
    setCollapsed((current) => {
      try {
        localStorage.setItem(SECTION_KEY, String(!current));
      } catch {
        // Ignore localStorage errors
      }
      return !current;
    });
  }, []);

  const handleHeight = useCallback((next: number | null) => {
    setHeight(next);
    saveHeight(next);
  }, []);

  const handleAddFolders = useCallback(async (project: Project) => {
    try {
      const selected = await open({
        directory: true,
        multiple: true,
        title: `Add folders to ${project.name}`,
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      for (const path of paths) {
        await projectsService.addFolder(project.id, path);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  const handleRename = useCallback((project: Project) => setNaming({ project }), []);

  const handleNamed = useCallback(
    async (name: string) => {
      try {
        if (naming?.project) await projectsService.renameProject(naming.project.id, name);
        else await projectsService.createProject(name);
        setNaming(null);
        setCollapsed(false);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [naming],
  );

  // A dragged height applies while the section is open; collapsed, it is just its header.
  const sized = height !== null && !collapsed;

  return (
    <div
      className={`relative shrink-0 flex flex-col border-t border-border ${sized ? "max-h-[75%]" : "max-h-[45%]"}`}
      style={sized ? { height: `${height}px` } : undefined}
    >
      {!collapsed && <ResizeHandle height={height} onResize={setHeight} onCommit={handleHeight} />}
      <div className="flex items-center justify-between pl-2 pr-3 py-1.5 shrink-0">
        <button
          type="button"
          className="flex items-center gap-1 cursor-pointer text-text-muted hover:text-text"
          onClick={handleCollapse}
        >
          <Chevron open={!collapsed} />
          <span className="text-sm font-medium">Projects</span>
          {!!projects?.length && (
            <span className="text-2xs font-medium min-w-4.75 h-4.75 flex items-center justify-center px-1 bg-bg-muted rounded-sm">
              {projects.length}
            </span>
          )}
        </button>
        <IconButton size="xs" title="New Project" onClick={() => setNaming({ project: null })}>
          <PlusIcon className="w-4.5 h-4.5 stroke-[1.4]" />
        </IconButton>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto flex flex-col gap-0.5 px-1.5 pb-1.5">
          {projects?.length === 0 && (
            <p className="px-2 pb-1 text-sm text-text-muted/70">
              Link folders from anywhere on your Mac. ChatGPT can search and read
              the markdown files in them.
            </p>
          )}
          {projects?.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              files={files}
              toggled={toggled}
              onToggle={handleToggle}
              onAddFolders={handleAddFolders}
              onRename={handleRename}
              onRefresh={readFolder}
            />
          ))}
        </div>
      )}
      <FolderNameDialog
        open={naming !== null}
        onOpenChange={(open) => !open && setNaming(null)}
        onConfirm={handleNamed}
        title={naming?.project ? "Rename project" : "New project"}
        description={
          naming?.project
            ? "Enter a new name for this project"
            : "A project is a collection of folders. Name it, then add folders from anywhere on your Mac."
        }
        confirmLabel={naming?.project ? "Rename" : "Create"}
        defaultValue={naming?.project?.name ?? ""}
        placeholder="Project name"
      />
    </div>
  );
}
