# ChatGSD - Development Guide

## Project Overview

ChatGSD is a markdown notes app you co-edit with ChatGPT, forked from [Scratch](https://github.com/erictli/scratch) by Eric Li. It's built with Tauri v2 (Rust backend) + React/TypeScript/Tailwind (frontend) + TipTap (WYSIWYG editor) + Tantivy (full-text search), and released for macOS. The bundle ID is `ai.chatgsd.desktop`; on first launch `src-tauri/src/legacy_data.rs` copies app data saved under Scratch's `com.scratch.app`. Internal names keep `scratch`: the `.scratch/` per-folder settings directory, the agent tool namespace, and the `scratch` CLI.

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
- The agent never writes note files directly. Codex App Server (`src-tauri/src/agent/codex/`, local stdio, Sign in with ChatGPT) edits the live TipTap doc through Scratch's dynamic document tools (`read_document`, `edit_document`, `replace_selection`). Read-only context tools (`search_notes`, `list_notes`, `read_notes`, `find_in_note`, `note_links`, reading fresh from disk via `agent/workspace.rs`) and `ask_user` (waits for the user, no timeout) complete the set. All are defined once in `src-tauri/src/agent/tools.rs`; editor tools and `ask_user` execute in the frontend over the `agent:tool-request` bridge. Native filesystem writes and command approvals are not an alternate editing route.
- Other notes change only through `edit_note` (`agent/note_edits.rs`): the backend validates the edits and sends a preview, the panel shows an approval card, and an approved edit is re-applied to the file as it is then and written compare-and-swap.
- Long notes: reads come back whole up to 400 lines, otherwise as an outline plus the opening, paged with `start_line`/`end_line` (`agent/reading.rs`). `edit_document` re-parses only the blocks an edit touches (`editedDocuments` in `src/lib/agent/documentTools.ts`), falling back to a full parse when the block index can't be built exactly.
- Conversations are per document and kept in `{APP_DATA}/agent/conversations/<folder key>/`, not in the notes folder (git sync would commit it). `agent/conversations.rs` maps stable document IDs to note IDs; the rename/move/delete commands update it. Codex manages model context and compaction. Existing readable conversations migrate without replaying encrypted reasoning. Computer-access turns use ephemeral Codex threads and retain text-only context so screenshot pixels are not stored in durable rollouts.
- Internet access is a separate Codex research role, not browsing tools on the co-editing agent. `research` uses its own model (`agentResearchModel`) and brief (`agentResearchBrief`; fixed rules live in `prompt.rs`). It searches with hosted web search and reads pages with `web_fetch` (`agent/web.rs`: public http(s) only, re-checked per redirect, HTML converted to markdown). Only its report returns to the conversation. `agentWebAccess` turns it off per folder.
- ChatGSD is the MCP client (`src-tauri/src/agent/mcp/`); Codex's own MCP support stays off. A remote server (Streamable HTTP) is added by its address: the name, tools and OAuth sign-in are read from the server (`oauth.rs`: protected-resource and authorization-server metadata, dynamic client registration, PKCE on a loopback port, resource indicators). Servers and their cached tool lists live in `{APP_DATA}/agent/mcp/servers.json`; tokens in `credentials.json` beside it (0600), never sent to the frontend.
- A local MCP server is a program defined in `{APP_DATA}/agent/mcp/mcp.json`, in the standard `mcpServers` format (`command`, `args`, `env`, `cwd`), and spoken to over stdio (`stdio.rs`). The file is the definition (`config.rs`): the form under More options writes to it, a hand edit counts the same, and `store.rs` merges its entries into the server list on every read, keeping what `servers.json` holds about each (on or off, tools, policies) under an ID derived from its name. `mcp_load_config`, called when settings opens or the window regains focus, restarts programs whose entry changed. Programs run as the user with the login shell's `PATH`, start when their server is on, and are stopped by closing stdin. Variables stay in the backend. Servers in Codex's `~/.codex/config.toml` are listed for the user to add; none is used until they do. The agent reaches every server through two fixed dynamic tools, `mcp_tools` and `mcp_call`, so changing servers never changes a thread's tool catalog; each message lists the enabled servers. Tools a server marks read-only run freely; anything else asks first on the `mcp_approval` bridge request (shown as a question card) unless the user set that tool to Allow or Off. A server saved as public is held to `web::PUBLIC` for every request, including its OAuth endpoints; one on this Mac or its network uses `web::ANY`. Redirects are never followed. `McpContext` follows `mcp:changed`; settings (`McpSettingsSection`) and the panel (`McpServices`) share it. Check-ins can't use MCP.
- Projects are collections of folders linked from anywhere on this Mac (`agent/projects.rs`, `ProjectsSection` in the sidebar). Only their paths are kept, in `{APP_DATA}/projects.json`, so they apply in every notes folder and nothing is copied or synced. The sidebar shows each folder's place, markdown count and last change; its files open in preview windows that carry the file's `project:` ID and have their own agent panel (`ProjectFileWorkspace` in `PreviewApp.tsx`, document from `AgentDocumentContext`), co-editing the open file live; its conversations are kept with the notes folder's. The agent sees every project's structure with `list_projects`, walks into folders by address, searches with `search_projects` (walked fresh each call, no index), and reads files with `read_notes`/`find_in_note` using `project:<name>/<folder label>/<path>` IDs. Project files are read-only: `edit_note` and `note_links` refuse them. Each message lists the projects.
- Skills are Agent Skills (`SKILL.md` plus optional text files) in `{APP_DATA}/agent/skills/<name>/`, managed by `agent/skills.rs` and `SkillsContext`. The prompt lists enabled skills by name and description; `read_skill` loads one. Nothing in a skill is executed. Only the user installs one: after research, `web.rs` checks the sites consulted for a discovery index (`/.well-known/agent-skills/index.json`, digests verified), the agent calls `offer_skill`, and the panel shows a `skill_offer` card. Saving sends back the content shown; an archived skill is re-downloaded and must match the offered digest.
- The agent panel is the only conversation surface; `AgentLauncher` shows its face while the panel is hidden. One check-in loop follows the user's edits (`useCoeditingObserver`, `reviewWriting` in `AgentContext.tsx`): the cheap Decisions gate (`agent/codex/decisions.rs`) picks nothing, a read-only offer, or, when an edit request is open, a write-capable continuation. A question it refuses or answers unusably counts as no concern (only a review with no usable concern fails), and what came back is appended to `{APP_DATA}/agent/decisions.log`. Messages are routed by `routeMessage` (`src/lib/agent/inlineDecision.ts`), which never holds one back.
- A message sent while the agent works on a request steers it instead of queueing (`agent_steer_run`, `steer` in `AgentContext`): the run loop in `agent/codex/mod.rs` passes it to Codex with `turn/steer` between steps, or starts the next turn with it if the turn had just ended. The composer shows Stop for the whole run and Steer once there is text. Background check-ins can't be steered; a message replaces them.
- The panel's selection is an attachment (`attachedSelection` in `AgentChanges.ts`): it stays highlighted and mapped through edits after the user clicks elsewhere, until a new selection, ×, deleting its text, or sending it.
- Generated UI uses json-render. `src/lib/agent/ui/catalog.ts` is the single source for the component vocabulary and the guide sent with each run; `src/components/agent/ui/registry.tsx` renders it. Replies may contain ```` ```spec ```` blocks (split by `src/lib/agent/ui/content.ts`); `ask_user` may carry a form spec, answered as JSON. The only thing a generated block can do is `Suggestions`: pills that send their own label as the user's message through `SuggestionContext`, live on the latest reply only.
- Agent replies and selection previews render with `@pierre/words` (`src/components/agent/AgentMarkdown.tsx`), highlighted by `@pierre/highlights`; panel styles for its output are the `.agent-panel-prose` rules in `App.css`. Both are WebAssembly, which is why the CSP allows `wasm-unsafe-eval`. Raw HTML and images are dropped; links and Copy go through `open_url_safe` and `copy_to_clipboard`. ```` ```spec ```` blocks are split out first and never reach it.
- Every writing offer carries a `trace`: the passages that drove it, each with what the agent read there and whether it was sure. "How I got here" draws it as the argument map (`ArgumentMap.ts` highlights, `ArgumentMapOverlay.tsx` margin nodes and arrows) and "Not what I meant" sends a `realign` request from a step. "Trace this argument" on the selection card works back from a highlight (`outcome`): `provenanceLedger` (`src/lib/agent/provenance.ts`) numbers what the panel transcript holds (the writer's messages, research, MCP calls, other notes read, edits), and a step citing an entry must quote that entry's own text. Check-in runs are ephemeral, so this ledger is how they see earlier tool calls. A map the writer asked for becomes a `trace` transcript item (`src/lib/agent/traceRecord.ts`; `agent_begin_conversation` starts a saved conversation if the note has none), and the next main message carries undelivered maps as context. Corrections are saved to working memory as `meaning-` choices in the writer's words; what a trace learned as `insight` entries, the agent's reading, capped at four and evicted first when memory is full.
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

The build hooks prepare checksum-pinned Codex 0.169.0 and its `codex-code-mode-host`
helper together in `resources/codex/`. Models that use code mode need that sibling
helper to call the document tools. Both executables are explicitly signed before
the enclosing app is notarized. `CHATGSD_CODEX_PATH` selects a development override;
its matching helper must sit beside it. Releases use the bundled executables.

Every push to `main` that passes CI is released automatically:

1. The workflow takes the highest `vMAJOR.MINOR.PATCH` tag (`scripts/next-version.sh`), bumps its patch number, tags the commit while it's still main's tip, and writes the version into the build with `scripts/set-version.mjs`. Versions live in tags, not commits, so the files on `main` keep the last hand-set version and pushes never race a bot commit
2. It builds, signs, notarizes, and verifies the signature, notarization ticket, Gatekeeper assessment and version, then publishes the release with the commit subjects since the last one. Installed copies update from that release's `latest.json`. A failed run deletes its draft and tag; retry with "Re-run all jobs"
3. It publishes the `chatgsd` npm package (`npm/chatgsd/`) at the same version, pinned to the release DMG's SHA-256, so `npx chatgsd` installs exactly that build. npm trusts `release.yml` in the `release` environment (trusted publishing, in the package's settings on npmjs.com; check with `npm trust list chatgsd`), so no npm token is stored
4. A run skips if `main` has moved on by the time CI finishes (the newer commit's run releases it) or the commit is already released. For a minor or major version, run the Release workflow by hand: `gh workflow run release.yml -f bump=minor`

Secrets live in the repo's `release` environment, reachable only from `main`: the Developer ID Application identity as a `.p12` (the same one sshkm signs with, team M9G92WURV3; only the Account Holder can create a new one) and an app-specific password for notarizing as the team's Apple ID. After renewing either, run `python3 scripts/configure-release-secrets.py <developer-id.p12>`; it checks both with Apple's tools before uploading. Updater signing key: `~/.tauri/scratch-fork-updater.key`, password in the login keychain item "Scratch fork updater key"; losing it means installed copies can no longer verify updates.
