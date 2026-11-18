# ChatGSD

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/app-icon.png">
  <img src="docs/app-icon-light.png" alt="ChatGSD" width="128" height="128">
</picture>

A markdown notes app you co-edit with Codex, signed in with ChatGPT. It's offline-first and keyboard-optimized, and your notes stay plain markdown files on your Mac.

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
- **Agent panel** - Co-edit with Codex through Sign in with ChatGPT (`Cmd+J`). Edits apply directly to the live note or other notes in the workspace, without approval cards. A separate agent caret and subtle working-range highlight show where it is working without taking your selection. Follow agent keeps its work in view until you scroll or type. While the panel is open it follows your edits: a cheap classifier decides after each pause whether to stay quiet, offer a suggestion, or continue an edit you asked for. Its face shows what it is doing and stays on a launcher when the panel is closed. Each note keeps its conversation history
- **Web research** - With internet access on, the agent hands questions your notes can't answer to a researcher: a separate Codex role that searches the web, reads pages and reports back with sources. Its model and brief are yours to change in Settings → Integrations
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

Codex App Server runs the agent over a local stdio connection. ChatGSD still owns
the editor tools, document-to-conversation mapping, and visible editing UI.
Signing in uses Codex's ChatGPT flow; your plan's Codex usage limits apply.
The previous direct-API sign-in is not reused, so existing users need to sign in
again after upgrading.

macOS builds bundle the checksum-verified Codex 0.169.0 executable and its
license notices. Source builds prepare it automatically. For development,
`CHATGSD_CODEX_PATH` selects an explicit executable; installed releases use the
bundled runtime rather than a globally installed CLI.

Existing transcripts stay available. Importing an older conversation requires
the same account, verified against its saved ownership information. If that
cannot be verified, start a new conversation rather than moving private history
to a different account.

Enabled skills are exposed through Codex's native skill discovery. ChatGSD keeps
installation and enablement under your control; disabled skills are excluded,
and skill scripts and dependency installers are not executed.

Scratch keeps document editing on its direct TipTap transaction tools. The agent
has a separate caret that follows its work while your selection stays yours.
Edits land immediately, with a subtle highlight on the agent's current edit,
without deletion ghosts or approval controls. Choose **Follow agent** in the
formatted editor to keep its caret in view without moving yours. Scrolling,
clicking in the editor, or typing pauses following; choose it again to rejoin.
The agent is guided to edit one paragraph or coherent section at a time, keeping
dependent edits together. A brief, staggered text reveal makes new words visible
as they arrive; each document transaction stays atomic, and reduced-motion
preferences disable the animation. Normal editor Undo works within the current
note and cannot restore a different note. Conflicting external disk changes
still use the existing merge review controls.

Each note keeps a working memory for the signed-in account. In the agent panel,
type a thought and choose **Hold for later** to save it with the selected
passage. Expand the saved items to revisit or forget one. The agent checks for
the requested follow-up as you write and saves its suggestion with the thought.
Assignments and wording choices also carry over across chats and app restarts.

Selecting text attaches it to the agent sidebar. Moving into the composer keeps
that selection ready to send. Clicking elsewhere in the note, collapsing the
selection with the keyboard, or pressing Escape clears the attachment. You can
also dismiss it with the selection card's close button.
After an agent edit, clicking in the note, moving the cursor, typing, or pressing
Escape also dismisses the run's selection highlight and the last working-range
highlight. The agent keeps its separate caret and edit target, so it can finish
the request without keeping your text visibly selected.
Opening the agent panel with `Cmd+Option+B`, `Cmd+J`, or its toolbar button focuses
the chat input right away. Closing it returns focus to the note without
moving your cursor, in both formatted and Markdown source mode.
Keyboard focus only crosses between the note and the sidebar when you move it:
`Cmd+Option+→` focuses the chat input, opening the sidebar if needed, and
`Cmd+Option+←` returns to the note where you left your cursor. Account checks,
coediting check-ins, and agent edits never move focus.

The panel is the one place to talk to the agent. Its header carries the
agent's face and a status line, and **Pause** stops assistance in the current
note until **Write with me** or your next message resumes it. `Cmd+Option+Enter`
in the note opens the composer with the current selection or cursor as context.
Enter sends; Shift+Enter adds a newline. Closing the panel keeps the draft, the
conversation and any work in progress, and leaves the face on a small launcher
below the note that reports what the agent is doing and reopens the panel. The
launcher also shows in focus mode.

Opening the panel starts writing check-ins, which continue from the launcher
after it closes. The agent takes one look at the whole note as soon as it is
following: a short note is read in full, a long one as up to 24 paragraph
openings spread from start to finish. After that it checks three seconds after
you stop typing or move to another part of the note, at most once every fifteen
seconds. Each check is one cheap `gpt-6-luna` Decisions request that evaluates
clarity, evidence, and development. A fourth question identifies the paragraph,
and a routing question chooses fast or deep work. These questions share one
bounded context: up to 6,000 characters of labelled prose, six recent messages,
and eight previously offered or dismissed suggestions. Unchanged passages reuse
the recent result, so staying put costs nothing. Blank notes and agent edits do
not start reviews.

A concern with probability at least 0.65 and a valid paragraph anchor starts the
writing agent. The classifier result is a lead, not a verified finding. The agent
reads the live note and makes one brief contextual offer, or stays silent if it
finds nothing worth adding. A newer offer replaces one you haven't touched; an
offer you have started answering or rewording stays. These background runs use
fresh ephemeral threads. They cannot access other apps or block on questions.
Evidence checks may use the enabled internet access, with one research task
limited to six search/fetch steps and a sixty-second research deadline. They do
not fill the chat history.

The agent makes a short rewrite itself when it finds one on its own: up to 400
characters, in text your cursor and selection are not in. It lands with the same
typing reveal as any agent edit, as one undo step, and the panel says what
changed with **Undo** and **Keep**. An undone change is not made again. Longer
rewrites, the sentence you are in, questions, moves and evidence stay offers.

A concern changes the face's expression and labels the reason: a claim
worth checking, a passage worth another look, or an idea to explore. A small
agent cursor glides from the face in the panel to the prose gutter beside the identified paragraph.
It never moves the user's mouse, typing cursor, or scroll position. **Show
passage** scrolls there and replays the gesture on request. Reduced motion skips the travel. Offscreen pointers hide instead of pointing
at unrelated text. Findings and pointers clear when the note changes or the
suggestion is dismissed. Results from an older document snapshot are discarded.

Four actions make the collaboration tangible: propose an editable rewrite,
trace an argument to one useful question, research a claim with opened sources,
and preview moving a paragraph earlier. Each appears as a json-render card in
the conversation. **Add to chat** stages the card's context in the composer
without sending it.
A question card can carry up to four suggested answers as pills; one click sends
it, and `Cmd+Enter` sends what you typed. A reply can end with suggested next
steps as pills too. Each pill sends exactly the text it shows, only the latest
reply's pills are live, and none can be clicked while the agent is working. The
starters above the composer are written for the note. As soon as the agent is
following a note, before its first look, one read-only Luna run proposes three or
four next moves. The note's text travels with the request, so that run takes one
model turn and no tool call. Any later check that raises something refreshes
them. Clicking one sends it as your message. A note you return to shows its last
starters at once while fresh ones are written. Until a note has any, four
standing starters show, ordered by the latest check's scores with the best fit
marked once it is more likely useful than not. A message you send first is never
queued behind that run.

An offer changes the document only when you accept it, in one undoable transaction.
Accepted rewrites and moves use the same progressive typing reveal and agent
caret as other agent edits; reduced motion shows the complete change immediately.
Changed or ambiguous passages disable acceptance until a fresh offer is made.

A cheap Decisions classifier chooses Luna for straightforward work and the
selected model for heavier reasoning. Low-confidence routing uses the selected
model; if Luna is unavailable, the selected model is the fallback. Explicit
messages also classify Discuss, Suggest, Edit, Research, and Clarify. Telling the
agent to change the text (rewrite, tighten, fix, shorten, move) is an edit and
is made in the note right away; it shows a version first only when you ask to
see one. Below 0.75 confidence no mode is sent and the agent reads the message
itself. A message is never held back by the classifier: one that fails to
classify, takes longer than 1.2 seconds, or exceeds 8,000 characters is sent as
written on the selected model.

The face combines an image-generated shell with animated LED eyes. The editing
model chooses expressions, sentiment, and intensity through a bounded
`set_expression` tool, based on the conversation rather than keyword matching.
These updates are expressive UI metadata, not claims of feelings or completion,
and never override errors, pauses, or waiting for your answer. Cursor-following
gaze stays local and is never sent to the model. Reduced-motion preferences
disable both gaze tracking and animation.

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

A request to change the note stays open after the agent replies. While it is
open, the check-in runs sooner: two seconds after you stop typing, at most once
every ten seconds, and the same cheap classifier also judges whether your edit
lets the agent continue. Only then does a full turn run, on Luna or the selected
model as routed. If a question is waiting, that turn tells the agent to read
again instead of pretending you answered. When the classifier is confident the
request is finished, check-ins return to the slower cadence. Questions,
suggestions and research never open a request. Changes made while the agent is
working wait until that turn finishes. Agent edits, selection moves and document
loading do not trigger check-ins. These check-ins use your ChatGPT plan.
**Pause** and errors stop them for the current note. Opening ChatGSD with the
panel closed does not start model requests.

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
| `Cmd+Option+→`    | Focus agent sidebar    |
| `Cmd+Option+←`    | Focus note             |
| `Cmd+Option+Enter` | Ask the agent about the selection |
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
