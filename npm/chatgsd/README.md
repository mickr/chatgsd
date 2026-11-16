# chatgsd

Installs or updates [ChatGSD](https://github.com/mickr/chatgsd), the markdown notes app you co-edit with ChatGPT, then opens it.

```bash
npx chatgsd             # install or update, then open
npx chatgsd notes.md    # open a file in it
```

Apple Silicon Macs only. Each version installs the ChatGSD release with the same number. The download must match the checksum published with this package, and the app must pass macOS's notarization check and carry ChatGSD's Developer ID signature, or nothing is installed. Once installed, ChatGSD updates itself.

Versions before 1.0 were a different, retired project.
