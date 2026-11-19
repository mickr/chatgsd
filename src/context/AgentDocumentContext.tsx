import { createContext, useContext } from "react";
import type { Note } from "../types/note";
import { useOptionalNotes } from "./NotesContext";

/** The document the agent works on, and how the panel opens another note. */
export interface AgentDocument {
  currentNote: Note | null;
  notesFolder: string | null;
  selectNote: (id: string) => void | Promise<void>;
}

const AgentDocumentContext = createContext<AgentDocument | null>(null);

/** Gives a window without the notes list (a project file's window) its own document. */
export const AgentDocumentProvider = AgentDocumentContext.Provider;

/** The window's own document when one is provided, otherwise the selected note. */
export function useAgentDocument(): AgentDocument {
  const own = useContext(AgentDocumentContext);
  const notes = useOptionalNotes();
  const document = own ?? notes;
  if (!document) throw new Error("useAgentDocument must be used within a NotesProvider or AgentDocumentProvider");
  return document;
}
