import { useState, useCallback, useRef, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { Editor, type PreviewModeData } from "../editor/Editor";
import * as filesService from "../../services/files";
import type { ExternalChange } from "../../lib/agent/merge";

interface PreviewAppProps {
  filePath: string;
}

export function PreviewApp({ filePath }: PreviewAppProps) {
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
      setExternalChange({ noteId: filePath, content: result.content, modified: result.modified, seq: ++externalSequenceRef.current });
    } catch (error) {
      console.error("Failed to read external file changes:", error);
      toast.error("Could not read the changes from disk.");
    }
  }, [filePath]);

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
    filePath,
    modified,
    externalChange,
    reloadVersion,
    save,
    reload,
  };

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
