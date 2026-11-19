import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { toast } from "sonner";
import { Editor, type PreviewModeData } from "../editor/Editor";
import { AgentPanel } from "../agent/AgentPanel";
import { AgentLauncher } from "../agent/AgentLauncher";
import { useAgentPanelShortcut } from "../agent/useAgentPanelShortcut";
import { AgentProvider, useAgent } from "../../context/AgentContext";
import { AgentDocumentProvider, type AgentDocument } from "../../context/AgentDocumentContext";
import { SkillsProvider } from "../../context/SkillsContext";
import { McpProvider } from "../../context/McpContext";
import * as filesService from "../../services/files";
import * as notesService from "../../services/notes";
import * as projectsService from "../../services/projects";
import type { ExternalChange } from "../../lib/agent/merge";

interface PreviewAppProps {
  filePath: string;
  /** Set when the file was opened from a project; the agent panel works on it under this ID. */
  projectId?: string | null;
}

export function PreviewApp({ filePath, projectId }: PreviewAppProps) {
  const noteId = projectId ?? filePath;
  const [content, setContent] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [modified, setModified] = useState(0);
  const [externalChange, setExternalChange] = useState<ExternalChange | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const externalSequenceRef = useRef(0);
  const readSequenceRef = useRef(0);
  const diskContentRef = useRef<string | null>(null);

  // Load file on mount
  useEffect(() => {
    filesService
      .readFileDirect(filePath)
      .then((result) => {
        diskContentRef.current = result.content;
        setContent(result.content);
        setTitle(result.title);
        setModified(result.modified);
      })
      .catch((error) => {
        console.error("Failed to load file:", error);
        toast.error(`Failed to load file: ${error}`);
      });
  }, [filePath]);

  const readExternalChange = useCallback(async () => {
    const sequence = ++readSequenceRef.current;
    try {
      const result = await filesService.readFileDirect(filePath);
      if (sequence !== readSequenceRef.current || diskContentRef.current === result.content) return;
      diskContentRef.current = result.content;
      setModified(result.modified);
      setTitle(result.title);
      setExternalChange({ noteId, content: result.content, modified: result.modified, seq: ++externalSequenceRef.current });
    } catch (error) {
      console.error("Failed to read external file changes:", error);
      toast.error("Could not read the changes from disk.");
    }
  }, [filePath, noteId]);

  useEffect(() => {
    const handleFocus = () => { void readExternalChange(); };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [readExternalChange]);

  const save = useCallback(
    async (newContent: string, expectedHash: string) => {
      const result = await filesService.saveFileDirect(filePath, newContent, expectedHash);
      if (result.status === "saved") {
        diskContentRef.current = newContent;
        setContent(newContent);
        setModified(result.note.modified);
        setTitle(result.note.title);
      }
      return result;
    },
    [filePath],
  );

  const reload = useCallback(async () => {
    try {
      const result = await filesService.readFileDirect(filePath);
      readSequenceRef.current++;
      diskContentRef.current = result.content;
      setContent(result.content);
      setTitle(result.title);
      setModified(result.modified);
      setExternalChange(null);
      setReloadVersion((v) => v + 1);
    } catch (error) {
      console.error("Failed to reload file:", error);
      toast.error(`Failed to reload: ${error}`);
    }
  }, [filePath]);

  // Listen for preview-file-change events
  useEffect(() => {
    const unlisten = listen<string>("preview-file-change", () => {
      void readExternalChange();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [readExternalChange]);

  // Keyboard shortcuts for preview mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const modKey = e.metaKey || e.ctrlKey;

      // Cmd+Shift+Enter: Toggle focus mode
      if (modKey && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        setFocusMode((prev) => !prev);
        return;
      }

      // Cmd+Shift+M: Toggle markdown source mode
      if (modKey && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-source-mode"));
        return;
      }

      // Cmd+Shift+P: Print
      if (modKey && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("print-note"));
        return;
      }

      // Cmd+P: Block browser print dialog
      if (modKey && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        return;
      }

      // Cmd+R: Reload file from disk
      if (modKey && e.key === "r") {
        e.preventDefault();
        reload();
        return;
      }

      // Escape: Exit focus mode
      if (e.key === "Escape" && focusMode) {
        e.preventDefault();
        setFocusMode(false);
        return;
      }

      // Trap Tab to prevent focus leaving editor (only when editor is focused)
      if (e.key === "Tab") {
        const active = document.activeElement;
        const editorEl = document.querySelector(".ProseMirror");
        if (editorEl && editorEl.contains(active)) {
          e.preventDefault();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusMode, reload]);

  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);

  const handleSaveToFolder = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      await filesService.importFileToFolder(filePath);
      // Backend emits select-note + focuses main window; close this preview
      await getCurrentWindow().close();
    } catch (error) {
      console.error("Failed to save to folder:", error);
      toast.error(`Failed to save to folder: ${error}`);
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [filePath]);

  const previewData: PreviewModeData = {
    content,
    title,
    noteId,
    filePath,
    modified,
    externalChange,
    reloadVersion,
    save,
    reload,
  };

  const exitFocusMode = useCallback(() => setFocusMode(false), []);

  if (projectId) {
    return (
      <ProjectFileWorkspace
        previewData={previewData}
        focusMode={focusMode}
        onExitFocusMode={exitFocusMode}
        onSaveToFolder={handleSaveToFolder}
        saveToFolderDisabled={isSaving}
      />
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-bg text-text">
      <Editor
        focusMode={focusMode}
        previewMode={previewData}
        onSaveToFolder={handleSaveToFolder}
        saveToFolderDisabled={isSaving}
      />
    </div>
  );
}

interface ProjectFileWorkspaceProps {
  previewData: PreviewModeData;
  focusMode: boolean;
  onExitFocusMode: () => void;
  onSaveToFolder: () => void;
  saveToFolderDisabled: boolean;
}

/** Opens a link from the panel: project files in their own window, notes in the main one. */
async function openFromPanel(id: string) {
  try {
    if (id.startsWith("project:")) {
      await projectsService.openFile(id);
      return;
    }
    await emitTo("main", "select-note", id);
    await (await Window.getByLabel("main"))?.setFocus();
  } catch (error) {
    toast.error(`Couldn't open the note: ${error}`);
  }
}

/** A project file's window: the note with the agent panel beside it, as in the main window. */
function ProjectFileWorkspace({ previewData, ...layout }: ProjectFileWorkspaceProps) {
  const editorRef = useRef<TiptapEditor | null>(null);
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const handleEditorReady = useCallback((ready: TiptapEditor | null) => {
    editorRef.current = ready;
    setEditor(ready);
  }, []);
  // Conversations and working memory are kept with the notes folder's, as for any note.
  const [notesFolder, setNotesFolder] = useState<string | null>(null);
  useEffect(() => {
    notesService.getNotesFolder().then(setNotesFolder).catch((error) => {
      console.error("Failed to read the notes folder:", error);
    });
  }, []);
  const { content, title, noteId, filePath, modified } = previewData;
  const currentNote = useMemo(
    () => (content === null ? null : { id: noteId, title, content, path: filePath, modified }),
    [content, title, noteId, filePath, modified],
  );
  const document = useMemo<AgentDocument>(
    () => ({ currentNote, notesFolder, selectNote: openFromPanel }),
    [currentNote, notesFolder],
  );
  return (
    <AgentDocumentProvider value={document}>
      <SkillsProvider>
        <McpProvider>
          <AgentProvider editorRef={editorRef} editor={editor}>
            <ProjectFileLayout previewData={previewData} hasNote={!!currentNote} onEditorReady={handleEditorReady} {...layout} />
          </AgentProvider>
        </McpProvider>
      </SkillsProvider>
    </AgentDocumentProvider>
  );
}

function ProjectFileLayout({
  previewData,
  hasNote,
  onEditorReady,
  focusMode,
  onExitFocusMode,
  onSaveToFolder,
  saveToFolderDisabled,
}: ProjectFileWorkspaceProps & { hasNote: boolean; onEditorReady: (editor: TiptapEditor | null) => void }) {
  const agent = useAgent();
  const togglePanel = useCallback(() => {
    onExitFocusMode();
    // Focus mode only hides an open panel, so bring it back instead of closing it.
    if (focusMode && agent.open) agent.focusPanel();
    else agent.toggle();
  }, [onExitFocusMode, focusMode, agent.open, agent.toggle, agent.focusPanel]);
  const focusPanel = useCallback(() => {
    onExitFocusMode();
    agent.focusPanel();
  }, [onExitFocusMode, agent.focusPanel]);
  useAgentPanelShortcut(true, togglePanel, focusPanel, agent.focusNote);
  const panelVisible = agent.open && !focusMode;
  return (
    <div className="h-full min-h-0 flex bg-bg text-text overflow-hidden">
      <div className="flex flex-1 flex-col min-w-0 min-h-0" data-writing-workspace>
        <Editor
          focusMode={focusMode}
          previewMode={previewData}
          onEditorReady={onEditorReady}
          onSaveToFolder={onSaveToFolder}
          saveToFolderDisabled={saveToFolderDisabled}
          agentPanelOpen={panelVisible}
          onToggleAgentPanel={togglePanel}
        />
        {hasNote && !panelVisible && <AgentLauncher onOpen={focusPanel} />}
      </div>
      <AgentPanel visible={panelVisible} />
    </div>
  );
}
