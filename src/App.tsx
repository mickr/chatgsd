import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { NotesProvider, useNotes } from "./context/NotesContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { listen } from "@tauri-apps/api/event";
import { GitProvider } from "./context/GitContext";
import { TooltipProvider, Toaster } from "./components/ui";
import { Sidebar } from "./components/layout/Sidebar";
import { SidebarResizeHandle } from "./components/layout/SidebarResizeHandle";
import { SIDEBAR_DEFAULT_PX } from "./lib/sidebar";
import { Editor } from "./components/editor/Editor";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { FolderPicker } from "./components/layout/FolderPicker";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { SettingsPage, type SettingsTab } from "./components/settings";
import { SpinnerIcon } from "./components/icons";
import { AgentProvider, useAgent } from "./context/AgentContext";
import { SkillsProvider } from "./context/SkillsContext";
import { McpProvider } from "./context/McpContext";
import { AgentPanel } from "./components/agent/AgentPanel";
import { useAgentPanelShortcut } from "./components/agent/useAgentPanelShortcut";
import { AgentLauncher } from "./components/agent/AgentLauncher";
import { KeyboardShortcutsModal } from "./components/shortcuts/KeyboardShortcutsModal";
import { PreviewApp } from "./components/preview/PreviewApp";
import {
  check as checkForUpdate,
  type Update,
} from "@tauri-apps/plugin-updater";
import { useUpdateMenu } from "./lib/useUpdateMenu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac, isWindows } from "./lib/platform";

// Detect preview mode from URL search params
function getWindowMode(): {
  isPreview: boolean;
  previewFile: string | null;
  previewProject: string | null;
} {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const file = params.get("file");
  return {
    isPreview: mode === "preview" && !!file,
    previewFile: file,
    previewProject: params.get("project"),
  };
}

type ViewState = "notes" | "settings";

function AppContent() {
  const editorRef = useRef<TiptapEditor | null>(null);
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const handleEditorReady = useCallback((ready: TiptapEditor | null) => {
    editorRef.current = ready;
    setEditor(ready);
  }, []);
  return (
    <SkillsProvider>
      <McpProvider>
        <AgentProvider editorRef={editorRef} editor={editor}>
          <AppWorkspace editorRef={editorRef} onEditorReady={handleEditorReady} />
        </AgentProvider>
      </McpProvider>
    </SkillsProvider>
  );
}

function AppWorkspace({ editorRef, onEditorReady }: {
  editorRef: React.RefObject<TiptapEditor | null>;
  onEditorReady: (editor: TiptapEditor | null) => void;
}) {
  const agent = useAgent();
  const {
    notesFolder,
    isLoading,
    createNote,
    duplicateNote,
    notes,
    selectedNoteId,
    selectNote,
    searchQuery,
    searchResults,
    reloadCurrentNote,
    currentNote,
    syncNotesFolder,
  } = useNotes();
  const { interfaceZoom, setInterfaceZoom, reloadSettings } = useTheme();
  const interfaceZoomRef = useRef(interfaceZoom);
  interfaceZoomRef.current = interfaceZoom;
  const currentNoteRef = useRef(currentNote);
  currentNoteRef.current = currentNote;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [view, setView] = useState<ViewState>("notes");
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const toggleAgentPanel = useCallback(() => {
    setFocusMode(false);
    // Focus mode only hides an open panel, so bring it back instead of closing it.
    if (focusMode && agent.open) agent.focusPanel();
    else agent.toggle();
  }, [focusMode, agent.open, agent.toggle, agent.focusPanel]);
  const focusAgentPanel = useCallback(() => {
    setFocusMode(false);
    agent.focusPanel();
  }, [agent.focusPanel]);
  useAgentPanelShortcut(view !== "settings", toggleAgentPanel, focusAgentPanel, agent.focusNote);

  // Listen for set-notes-folder event from CLI (scratch .)
  // Placed here in AppContent where both NotesContext and ThemeContext are available
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("set-notes-folder", async (event) => {
      await syncNotesFolder(event.payload);
      await reloadSettings();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [syncNotesFolder, reloadSettings]);

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((prev) => !prev);
  }, []);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      // Don't enter focus mode without a selected note
      if (!prev && !selectedNoteId) return prev;
      if (prev) {
        // Exiting focus mode — always restore sidebar
        setSidebarVisible(true);
      }
      return !prev;
    });
  }, [selectedNoteId]);

  const toggleSettings = useCallback(() => {
    setSettingsTab(undefined);
    setView((prev) => (prev === "settings" ? "notes" : "settings"));
  }, []);

  const closeSettings = useCallback(() => {
    setView("notes");
    setSettingsTab(undefined);
  }, []);

  const manageMcpServers = useCallback(() => {
    setSettingsTab("mcp");
    setView("settings");
  }, []);


  // Memoize display items to prevent unnecessary recalculations
  const displayItems = useMemo(() => {
    return searchQuery.trim() ? searchResults : notes;
  }, [searchQuery, searchResults, notes]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInEditor = !!target.closest(".ProseMirror");
      const isInInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      const isEditorEmpty =
        isInEditor && currentNoteRef.current?.content.trim() === "";

      // Cmd+, - Toggle settings (always works, even in settings)
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        toggleSettings();
        return;
      }

      // Cmd+= or Cmd++ - Zoom in (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setInterfaceZoom((prev) => prev + 0.05);
        const newZoom = Math.round(Math.min(interfaceZoomRef.current + 0.05, 1.5) * 20) / 20;
        toast(`Zoom ${Math.round(newZoom * 100)}%`, { id: "zoom", duration: 1500 });
        return;
      }

      // Cmd+- - Zoom out (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        setInterfaceZoom((prev) => prev - 0.05);
        const newZoom = Math.round(Math.max(interfaceZoomRef.current - 0.05, 0.7) * 20) / 20;
        toast(`Zoom ${Math.round(newZoom * 100)}%`, { id: "zoom", duration: 1500 });
        return;
      }

      // Cmd+0 - Reset zoom (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        setInterfaceZoom(1.0);
        toast("Zoom 100%", { id: "zoom", duration: 1500 });
        return;
      }

      // Block all other shortcuts when in settings view
      if (view === "settings") {
        return;
      }


      // Cmd+Shift+Enter - Toggle focus mode
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        toggleFocusMode();
        return;
      }

      // Cmd+Shift+M - Toggle markdown source mode
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "m"
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-source-mode"));
        return;
      }

      // Escape exits focus mode when not in editor
      if (e.key === "Escape" && focusMode && !isInEditor) {
        e.preventDefault();
        toggleFocusMode();
        return;
      }

      // Let dialogs handle their own keyboard events (Tab, Enter, etc.)
      if (target.closest("[role='dialog'], [role='alertdialog']")) {
        return;
      }

      if (target.closest(".agent-panel, .agent-launcher-dock") && !e.metaKey && !e.ctrlKey) {
        if (e.key === "Escape") {
          e.preventDefault();
          editorRef.current?.commands.focus();
        }
        return;
      }

      // Trap Tab/Shift+Tab in notes view only - prevent focus navigation
      // TipTap handles indentation internally before event bubbles up
      if (e.key === "Tab" && !target.closest(".agent-panel, .agent-launcher-dock")) {
        e.preventDefault();
        return;
      }

      // Cmd+P - Open command palette
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      // Cmd+Shift+P - Print
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("print-note"));
        return;
      }

      // Cmd+/ - Open keyboard shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // Cmd/Ctrl+Shift+F - Open sidebar search
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setSidebarVisible(true);
        window.dispatchEvent(new CustomEvent("open-sidebar-search"));
        return;
      }

      // Cmd+Shift+B - Toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Cmd+N - New note
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        createNote();
        return;
      }

      // Delete current note (note list focused, or editor on empty note)
      if (
        selectedNoteId &&
        !isInInput &&
        (e.key === "Delete" ||
          (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) &&
        (!isInEditor || isEditorEmpty)
      ) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("request-delete-note", { detail: selectedNoteId }),
        );
        return;
      }

      // Cmd+D - Duplicate current note
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "d" &&
        !isInEditor &&
        !isInInput &&
        selectedNoteId
      ) {
        e.preventDefault();
        duplicateNote(selectedNoteId);
        return;
      }

      // Cmd+R - Reload current note (pull external changes)
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        reloadCurrentNote();
        return;
      }

      // Arrow keys for note navigation
      // Skip if folder tree view is handling its own navigation
      const isInFolderTree = !!(e.target as HTMLElement).closest("[data-folder-tree]");
      if (
        displayItems.length > 0 &&
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        ((!isInEditor && !isInInput) || isEditorEmpty) &&
        !isInFolderTree
      ) {
        e.preventDefault();
        const currentIndex = displayItems.findIndex(
          (n) => n.id === selectedNoteId,
        );
        let newIndex: number;

        if (e.key === "ArrowDown") {
          newIndex =
            currentIndex < displayItems.length - 1 ? currentIndex + 1 : 0;
        } else {
          newIndex =
            currentIndex > 0 ? currentIndex - 1 : displayItems.length - 1;
        }

        selectNote(displayItems[newIndex].id);
        window.dispatchEvent(new CustomEvent("focus-note-list"));
        return;
      }

      // Enter to focus editor
      if (e.key === "Enter" && selectedNoteId && !isInEditor && !isInInput) {
        e.preventDefault();
        const editor = document.querySelector(".ProseMirror") as HTMLElement;
        if (editor) {
          editor.focus();
        }
        return;
      }

      // Escape to blur editor and go back to note list
      if (e.key === "Escape" && isInEditor) {
        e.preventDefault();
        (target as HTMLElement).blur();
        // Focus the note list for keyboard navigation
        window.dispatchEvent(new CustomEvent("focus-note-list"));
        return;
      }
    };

    // Disable right-click context menu except in editor
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Allow context menu in editor (prose class), inputs, and note list sidebar
      const isInEditor =
        target.closest(".prose") || target.closest(".ProseMirror");
      const isInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      const isInNoteList = target.closest("[data-note-list]");
      if (!isInEditor && !isInput && !isInNoteList) {
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("contextmenu", handleContextMenu);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [
    createNote,
    duplicateNote,
    displayItems,
    reloadCurrentNote,
    selectedNoteId,
    selectNote,
    toggleSettings,
    toggleSidebar,
    toggleFocusMode,
    focusMode,
    view,
    setInterfaceZoom,
    toggleAgentPanel,
  ]);

  const handleClosePalette = useCallback(() => {
    setPaletteOpen(false);
    editorRef.current?.commands.focus();
  }, []);

  if (isLoading) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center bg-bg-secondary">
        <div className="text-text-muted/70 text-sm flex items-center gap-1.5 font-medium">
          <SpinnerIcon className="w-4.5 h-4.5 stroke-[1.5] animate-spin" />
          Initializing ChatGSD...
        </div>
      </div>
    );
  }

  if (!notesFolder) {
    return <FolderPicker />;
  }

  return (
    <>
      <div className="h-full min-h-0 flex bg-bg text-text overflow-hidden">
        {view === "settings" ? (
          <SettingsPage onBack={closeSettings} initialTab={settingsTab} />
        ) : (
          <>
            <div
              data-sidebar
              style={{ width: (!sidebarVisible || focusMode) ? 0 : `var(--sidebar-width, ${SIDEBAR_DEFAULT_PX}px)` }}
              className={`relative transition-all duration-500 ease-out overflow-hidden ${!sidebarVisible || focusMode ? "opacity-0 -translate-x-4 pointer-events-none" : "opacity-100 translate-x-0"}`}
            >
              <Sidebar onOpenSettings={toggleSettings} />
              {sidebarVisible && !focusMode && <SidebarResizeHandle />}
            </div>
            <div className="flex flex-1 flex-col min-w-0 min-h-0" data-writing-workspace>
              <Editor
                onToggleSidebar={toggleSidebar}
                sidebarVisible={sidebarVisible}
                focusMode={focusMode}
                onEditorReady={onEditorReady}
                agentPanelOpen={agent.open && !focusMode}
                onToggleAgentPanel={toggleAgentPanel}
              />
              {currentNote && !(agent.open && !focusMode) && (
                <AgentLauncher onOpen={focusAgentPanel} />
              )}
            </div>
            <AgentPanel visible={agent.open && !focusMode} onManageServers={manageMcpServers} />
          </>
        )}
      </div>

      {/* Command palette backdrop */}
      {paletteOpen && (
        <div
          className="fixed inset-0 bg-text/50 backdrop-blur-sm z-40 animate-fade-in"
          onClick={() => {
            if (paletteOpen) handleClosePalette();
          }}
        />
      )}

      <KeyboardShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={handleClosePalette}
        onOpenSettings={toggleSettings}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onToggleAgentPanel={toggleAgentPanel}
        focusMode={focusMode}
        onToggleFocusMode={toggleFocusMode}
        editorRef={editorRef}
      />
    </>
  );
}

// Shared update check — used by startup and manual "Check for Updates"
async function showUpdateToast(): Promise<"update" | "no-update" | "error"> {
  try {
    const update = await checkForUpdate();
    if (update) {
      toast(<UpdateToast update={update} toastId="update-toast" />, {
        id: "update-toast",
        duration: Infinity,
        closeButton: true,
      });
      return "update";
    }
    return "no-update";
  } catch (err) {
    console.error("Update check failed:", err);
    return "error";
  }
}

export { showUpdateToast };

function UpdateToast({
  update,
  toastId,
}: {
  update: Update;
  toastId: string | number;
}) {
  const [installing, setInstalling] = useState(false);

  const handleUpdate = async () => {
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      toast.dismiss(toastId);
      toast.success("Update installed! Restart ChatGSD to apply.", {
        duration: Infinity,
        closeButton: true,
      });
    } catch (err) {
      console.error("Update failed:", err);
      toast.error("Update failed. Please try again later.");
      setInstalling(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium text-sm">
        Update Available: v{update.version}
      </div>
      {update.body && (
        <div className="text-xs text-text-muted line-clamp-3">
          {update.body}
        </div>
      )}
      <button
        onClick={handleUpdate}
        disabled={installing}
        className="self-start mt-1 text-xs font-medium px-3 py-1.5 rounded-md bg-text text-bg hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {installing ? "Installing..." : "Update Now"}
      </button>
    </div>
  );
}

function App() {
  const { isPreview, previewFile, previewProject } = useMemo(getWindowMode, []);
  useUpdateMenu(showUpdateToast);

  // Cmd/Ctrl+W — close window (works in both preview and folder mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        getCurrentWindow().close().catch(console.error);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Add platform class for OS-specific styling (e.g., keyboard shortcuts)
  useEffect(() => {
    const os = isMac ? "mac" : isWindows ? "windows" : "linux";
    document.documentElement.classList.add(`platform-${os}`);
  }, []);

  // Check for app updates on startup (folder mode only)
  useEffect(() => {
    if (isPreview) return;
    const timer = setTimeout(() => showUpdateToast(), 3000);
    return () => clearTimeout(timer);
  }, [isPreview]);

  // Preview mode: lightweight editor without sidebar, search, git
  if (isPreview && previewFile) {
    return (
      <ThemeProvider>
        <Toaster />
        <TooltipProvider>
          <PreviewApp filePath={decodeURIComponent(previewFile)} projectId={previewProject} />
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  // Folder mode: full app with sidebar, search, git, etc.
  return (
    <ThemeProvider>
      <Toaster />
      <TooltipProvider>
        <NotesProvider>
          <GitProvider>
            <AppContent />
          </GitProvider>
        </NotesProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
