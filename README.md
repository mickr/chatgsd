# ChatGSD

<img src="docs/app-icon.png" alt="ChatGSD" width="128" height="128" style="border-radius: 22px; margin-bottom: 8px;">

A markdown notes app you co-edit with ChatGPT. It's offline-first and keyboard-optimized, and your notes stay plain markdown files on your Mac.

ChatGSD is a fork of [Scratch](https://github.com/erictli/scratch) by Eric Li.

![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

[Releases](https://github.com/mickr/chatgsd/releases)

## Features

- **Offline-first** - No cloud, no account, no internet required
- **Markdown-based** - Notes stored as plain `.md` files you own
- **WYSIWYG editing** - Rich text editing that saves as markdown
- **Preview mode** - Open any `.md` file via drag-and-drop or "Open With" without a notes folder
- **Markdown source mode** - Toggle to view and edit raw markdown (`Cmd+Shift+M`)
- **Syntax highlighting** - 20 languages with GitHub-inspired color scheme
- **Mermaid diagrams** - Render flowcharts, sequence diagrams, and more in fenced code blocks
- **KaTeX math** - Render block `$$...$$` math equations
- **Wikilinks** - Type `[[` to link between notes with autocomplete
- **Slash commands** - Type `/` to quickly insert headings, lists, code blocks, diagrams, and more
- **Focus mode** - Distraction-free writing with animated sidebar/toolbar fade (`Cmd+Shift+Enter`)
- **Agent panel** - Co-edit with ChatGPT through Sign in with ChatGPT (`Cmd+J`). Edits apply directly to the live note or other notes in the workspace, without approval cards. A separate agent caret shows where it is working without adding highlights or taking your selection. During an active coediting session, it observes your edits and checks in after you pause typing. Each note keeps its conversation history
- **Web research** - With internet access on, the agent hands questions your notes can't answer to a researcher: a separate agent role that searches the web, reads pages and reports back with sources. Its model (Luna by default) and brief are yours to change in Settings → Integrations
- **Skills** - Save [Agent Skills](https://agentskills.io) for the agent to follow. When a site the researcher reads publishes a skill that fits your work, the agent offers it on a card with its full instructions, and you decide whether to save it. Manage, switch off, remove or add skills by address in Settings → Skills
- **Works with other AI agents** - Changes made to an open note on disk merge in live, and conflicting edits show up as changes to review
- **Folders** - Opt-in collapsible folder tree with drag-and-drop to organize notes
- **Keyboard optimized** - Lots of shortcuts and a command palette
- **Customizable** - Theme, typography, page width, and RTL text direction
- **Git integration** - Optional version control with push/pull for multi-device sync
- **Lightweight** - 5-10x smaller than Obsidian or Notion

## Screenshot

![Screenshot](docs/screenshot.png)

## Installation

### macOS (Apple Silicon)

```bash
npx chatgsd
```

That installs or updates ChatGSD and opens it. Or download it yourself:

1. Download the latest `.dmg` from [Releases](https://github.com/mickr/chatgsd/releases)
2. Open the DMG and drag ChatGSD to Applications
3. Open ChatGSD from Applications. It updates itself from then on

Choose **ChatGSD → Check for Updates…** in the macOS menu bar to check manually,
including from a standalone note window. The result offers an available update,
confirms you're up to date, or reports that the check failed. Only the active
window checks and shows the result.

### From Source

**Prerequisites:** Node.js 18+, Rust 1.70+

**macOS:** Xcode Command Line Tools

```bash
git clone https://github.com/mickr/chatgsd.git
cd chatgsd
npm install
npm run tauri dev      # Development
npm run tauri build    # Production build
```

## Computer-assisted coediting

Scratch keeps document editing on its direct TipTap transaction tools. The agent
has a separate caret that follows its work while your selection stays yours.
Edits land immediately, without new highlighting, deletion ghosts, or approval
controls. A brief, staggered text reveal makes new words visible as they arrive;
the document transaction stays atomic, and reduced-motion preferences disable
the animation. Normal editor Undo works within the current note and cannot
restore a different note. Conflicting external disk changes still use the
existing merge review controls.

Selecting text attaches it to the agent sidebar. Moving into the composer keeps
that selection ready to send. Clicking elsewhere in the note, collapsing the
selection with the keyboard, or pressing Escape clears the attachment. You can
also dismiss it with the selection card's close button.
Opening the agent panel with `Cmd+Option+B`, `Cmd+J`, or its toolbar button focuses
the chat input when it is ready. Closing it returns focus to the note without
moving your cursor, in both formatted and Markdown source mode.

In the formatted editor, `Cmd+Option+Enter` opens a small inline edit prompt at
the selection or cursor and checks your ChatGPT account without opening the
sidebar first. Enter sends; Shift+Enter adds a newline; Escape returns
to the note. Requests include up to 2,000 document positions of surrounding prose
on each side and tell the agent to read the rest of the note when it needs more
context. The selection is the default edit target; without one, the cursor is
the insertion point. While the prompt stays open, its target follows document
edits and remains available for retries and follow-up instructions.
Inline edits use the same conversation and direct editing
tools as the sidebar, with computer access disabled for the inline request.
**Continue in sidebar** opens the full conversation, including questions and
change records. **Pause** stops the active coediting session.

Small gutter markers identify passages changed in the latest editing turn.
Hover, click, or focus a marker to inspect a read-only, word-level before/after
diff rendered by [Pierre Diffs](https://diffs.com/). The viewer loads only when
opened. Markers follow text as it moves and disappear when you edit their passage
or switch notes; the saved record remains available.

Each new editing turn also has a **Changes this turn** card in the conversation.
Successful edits are saved as they happen, including other-note edits and edits
made before a turn was interrupted. They remain available in earlier conversations.
Saves use stable session ownership, so renaming a note while a save is queued
does not lose its recorded changes.
The record excludes your own intervening edits; later typing or Undo does not
rewrite it. This is an edit-time record, not an approval step or a new revision
system. Conversations saved before change recording was added have no diff cards.

Sending a message or choosing **Start coediting** activates observation for the
current note. Local edits trigger a check-in after two seconds without typing,
at most once every ten seconds. Changes made while the agent is working wait
until that turn finishes. Agent edits, selection moves and document loading do
not trigger more turns. If a question is waiting, a document edit tells the agent
to read again rather than pretending you answered. These check-ins use your
ChatGPT plan. **Pause**, closing the panel, switching notes, and errors stop
automatic check-ins. Opening Scratch alone does not start model requests.

macOS installs and automatic updates include [Cua Driver](https://cua.ai/docs/cua-driver/quickstart)
0.38.0, so computer use needs no separate driver installation. Computer use requires
macOS 13 or later. **Computer access** is on by default under **Settings →
Integrations → Agent**. The choice is saved with the notes folder; turning it
off pauses the active session. For example: “Find the project brief in Box and use
it to update this section.” The run can access other apps and your signed-in
browser; captured text and screenshots are sent to ChatGPT. Screenshot pixels
are not saved in Scratch's conversation history, but tool text and extracted
information can be.

On macOS, choose **Set up Cua permissions** in Settings → Integrations, grant ChatGSD Accessibility and
Screen Recording in System Settings, then fully quit and reopen ChatGSD.
ChatGSD starts its bundled driver as an embedded child process, so those grants
belong to ChatGSD. Installing or updating the app does not grant OS permissions.
Apple Silicon source builds prepare the pinned, checksum-verified driver automatically
before `tauri dev` or `tauri build`. `CUA_DRIVER_PATH` can select an explicit
executable for development; otherwise the bundled copy takes priority over PATH.

Computer use is background-only; desktop input and foreground delivery are
rejected. Unsupported interactions fail rather than take over your keyboard or
mouse. Scratch note edits stay on the direct editor tools. Sign-in, MFA, CAPTCHAs
and OS permission prompts stay with you. **Pause** ends the run and its owned
Cua processes; it does not undo actions already performed in other apps. Only
one computer-use run may control other apps at a time.

## Keyboard Shortcuts

ChatGSD is designed to be usable without a mouse. Here are the essentials to get started:

| Shortcut          | Action                 |
| ----------------- | ---------------------- |
| `Cmd+N`           | New note               |
| `Cmd+D`           | Duplicate note         |
| `Delete`          | Delete note            |
| `Cmd+Backspace`   | Delete note            |
| `Cmd+P`           | Command palette        |
| `Cmd+K`           | Add/edit link          |
| `Cmd+F`           | Find in note           |
| `Cmd+Shift+C`     | Copy & Export menu     |
| `Cmd+Shift+M`     | Toggle Markdown source |
| `Cmd+Shift+Enter` | Toggle Focus mode      |
| `Cmd+Shift+F`     | Search notes           |
| `Cmd+J`           | Toggle agent panel     |
| `Cmd+Option+B`    | Toggle agent panel     |
| `Cmd+Option+Enter` | Inline AI edit        |
| `Cmd+R`           | Reload current note    |
| `Cmd+,`           | Open settings          |
| `Cmd+\`           | Toggle sidebar         |
| `Cmd+B/I`         | Bold/Italic            |
| `Cmd+=/-/0`       | Zoom in/out/reset      |
| `↑/↓`             | Navigate notes         |

**Note:** On Windows, use `Ctrl` instead of `Cmd` for all shortcuts.

Many more shortcuts and features are available in the app—explore via the command palette (`Cmd+P` / `Ctrl+P`) or view the full reference in Settings → Shortcuts.

## Built With

[Tauri](https://tauri.app/) · [React](https://react.dev/) · [TipTap](https://tiptap.dev/) · [Tailwind CSS](https://tailwindcss.com/) · [Tantivy](https://github.com/quickwit-oss/tantivy)

## Contributing

Issues and pull requests are welcome at [mickr/chatgsd](https://github.com/mickr/chatgsd). Keep pull requests small and focused.

## License

[MIT](LICENSE). Copyright Eric Li (Scratch) and Mick Ryan (ChatGSD).
