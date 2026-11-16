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

Releases are macOS only, built, signed with Developer ID, and notarized by `.github/workflows/release.yml` on the self-hosted `mars-scratch` runner (this Mac; installed in `~/.local/share/github-actions/mars-scratch`, LaunchAgent `actions.runner.mickr-scratch.mars-scratch`).

Every push to `main` that passes CI is released automatically:

1. The workflow takes the latest `v*` tag, bumps its patch number, and writes that version into the build with `scripts/set-version.mjs`. Versions live in tags, not commits, so the files on `main` keep the last hand-set version and pushes never race a bot commit
2. It builds, signs, notarizes, and verifies the signature, notarization ticket, Gatekeeper assessment and version, then publishes the release with the commit subjects since the last one. Publishing creates the tag on the built commit. Installed copies update from that release's `latest.json`
3. A run skips if `main` has moved on by the time CI finishes (the newer commit's run releases it) or the commit is already released. For a minor or major version, run the Release workflow by hand: `gh workflow run release.yml -f bump=minor`

Secrets live in the repo's `release` environment, reachable only from `main`: the Developer ID Application identity as a `.p12` (the same one sshkm signs with, team M9G92WURV3; only the Account Holder can create a new one) and an app-specific password for notarizing as the team's Apple ID. After renewing either, run `python3 scripts/configure-release-secrets.py <developer-id.p12>`; it checks both with Apple's tools before uploading. Updater signing key: `~/.tauri/scratch-fork-updater.key`, password in the login keychain item "Scratch fork updater key"; losing it means installed copies can no longer verify updates.
