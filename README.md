# ChatGSD

<img src="docs/app-icon.png" alt="ChatGSD" width="128" height="128" style="border-radius: 22px; margin-bottom: 8px;">

A markdown notes app you co-edit with ChatGPT. It's offline-first and keyboard-optimized, and your notes stay plain markdown files on your Mac.

ChatGSD is a fork of [Scratch](https://github.com/erictli/scratch) by Eric Li.

![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

[Releases](https://github.com/mickr/scratch/releases)

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
- **Agent panel** - Co-edit with ChatGPT, using your ChatGPT plan through Sign in with ChatGPT (`Cmd+J`). It reads your live note and the selection you attach, pulls context from your other notes and their links, works through notes thousands of lines long, asks you to clarify when a request is ambiguous, and shows comparisons and facts as small views. Edits to the open note show up as tracked changes you accept or reject while you keep typing; edits to other notes come as previews you approve in the panel. Each note keeps its conversation history
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

1. Download the latest `.dmg` from [Releases](https://github.com/mickr/scratch/releases)
2. Open the DMG and drag ChatGSD to Applications
3. Open ChatGSD from Applications. It updates itself from then on

### From Source

**Prerequisites:** Node.js 18+, Rust 1.70+

**macOS:** Xcode Command Line Tools

```bash
git clone https://github.com/mickr/scratch.git
cd scratch
npm install
npm run tauri dev      # Development
npm run tauri build    # Production build
```

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

Issues and pull requests are welcome at [mickr/scratch](https://github.com/mickr/scratch). Keep pull requests small and focused.

## License

[MIT](LICENSE). Copyright Eric Li (Scratch) and Mick Ryan (ChatGSD).
