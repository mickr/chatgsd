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
- The agent never writes note files. ChatGPT (`src-tauri/src/agent/chatgpt/`: Sign in with ChatGPT OAuth plus a Responses API tool loop) edits the live TipTap doc through Scratch's document tools (`read_document`, `edit_document`, `replace_selection`, plus read-only `search_notes`/`read_note`). They're defined once in `src-tauri/src/agent/tools.rs` and the document tools execute in `src/lib/agent/documentTools.ts` over the `agent:tool-request` bridge.
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
