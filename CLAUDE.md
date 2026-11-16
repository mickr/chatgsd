# Scratch - Development Guide

## Project Overview

Scratch is a cross-platform markdown note-taking app for macOS, Windows, and Linux, built with Tauri v2 (Rust backend) + React/TypeScript/Tailwind (frontend) + TipTap (WYSIWYG editor) + Tantivy (full-text search).

## Commands

```bash
npm run dev          # Start Vite dev server only
npm run build        # Build frontend (tsc + vite)
npm test             # Frontend unit tests (Vitest, jsdom)
npm run tauri dev    # Run full app in development mode
npm run tauri build  # Build production app
```

## CI

Runs on every push to `main` and on PRs. Validates frontend build (`tsc` + Vite), frontend unit tests (`npm test`), and Rust compilation (`cargo check` + `cargo clippy`) on an Ubuntu runner.

## Key Patterns

- All backend operations go through Tauri commands registered in `src-tauri/src/lib.rs` (agent commands live in `src-tauri/src/agent/`). Frontend calls them via `invoke()` from `@tauri-apps/api/core`.
- `NotesContext` uses a dual context pattern (data/actions separated) for performance.
- Settings live in two places: app config at `{APP_DATA}/config.json`, per-folder settings at `{NOTES_FOLDER}/.scratch/settings.json`.
- Tauri v2 permissions go in `src-tauri/capabilities/default.json`.
- The agent never writes note files directly. ChatGPT (`src-tauri/src/agent/chatgpt/`: Sign in with ChatGPT OAuth plus a Responses API tool loop) edits the live TipTap doc through Scratch's document tools (`read_document`, `edit_document`, `replace_selection`). Read-only context tools (`search_notes`, `list_notes`, `read_notes`, `find_in_note`, `note_links`, reading fresh from disk via `agent/workspace.rs`) and `ask_user` (waits for the user, no timeout) complete the set. All are defined once in `src-tauri/src/agent/tools.rs`; editor tools and `ask_user` execute in the frontend over the `agent:tool-request` bridge.
- Other notes change only through `edit_note` (`agent/note_edits.rs`): the backend validates the edits and sends a preview, the panel shows an approval card, and an approved edit is re-applied to the file as it is then and written compare-and-swap.
- Long notes: reads come back whole up to 400 lines, otherwise as an outline plus the opening, paged with `start_line`/`end_line` (`agent/reading.rs`). `edit_document` re-parses only the blocks an edit touches (`editedDocuments` in `src/lib/agent/documentTools.ts`), falling back to a full parse when the block index can't be built exactly.
- Conversations are per document and kept in `{APP_DATA}/agent/conversations/<folder key>/`, not in the notes folder (git sync would commit it). `agent/conversations.rs` maps stable document IDs to note IDs; the rename/move/delete commands update it. Model input is trimmed by `chatgpt/context.rs` (old tool outputs stubbed when a turn starts; oldest turns dropped over budget) because the plan route has no server-side truncation.
- The panel's selection is an attachment (`attachedSelection` in `AgentChanges.ts`): it stays highlighted and mapped through edits after the user clicks elsewhere, until a new selection, ×, deleting its text, or sending it.
- Generated UI uses json-render. `src/lib/agent/ui/catalog.ts` is the single source for the component vocabulary and the guide sent with each run; `src/components/agent/ui/registry.tsx` renders it. Replies may contain ```` ```spec ```` blocks (split by `src/lib/agent/ui/content.ts`); `ask_user` may carry a form spec, answered as JSON.
- Agent edits land as tracked hunks (`src/components/editor/AgentChanges.ts`). One tool call's edits are one transaction, so a batch applies atomically.
- Saves are compare-and-swap: `save_note`/`save_file_direct` take the SHA-256 of the last disk-synced content and return a conflict instead of overwriting an outside write. External changes and save conflicts both go through the block-level three-way merge in `src/lib/agent/merge.ts`.

## Coding Conventions

- Clean, minimal code with low technical debt
- Proper React patterns (contexts, hooks, memoization)
- Type-safe with TypeScript throughout
- No commented-out code or TODOs in production code
- Use `React.memo` for expensive list-item components
- Use `useCallback`/`useMemo` for performance-critical paths
- Debounce user-triggered operations (auto-save 300ms, search 150ms, file watcher 500ms, git status 1000ms)
- All operations should be non-blocking (async)
- Error handling with user-friendly messages

## Releasing

1. Bump version in `package.json` and `src-tauri/tauri.conf.json`
2. Commit to `main`, then tag and push: `git tag v0.5.0 && git push origin v0.5.0`
3. The release workflow builds all platforms and creates a draft GitHub release
4. Update the description in `latest.json` from GitHub after the action finishes
5. Review, edit notes, and publish
