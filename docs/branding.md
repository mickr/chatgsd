# Robot artwork

The robot and icon variants were created with the built-in imagegen tool.
Keep the loose, thin pen strokes and seated checklist pose. The approved direction
is a hand-drawn character, not a geometric robot head or completion badge.

- `public/gsd-robot.png` contains only the robot's ink on transparency. The editor
  uses its alpha channel as a mask, colored with the current theme's text color.
- `app-icon.png` is the dark Mac icon source. `app-icon-light.png` is the ivory
  alternative. Both include transparent corners and margins.
- `src-tauri/icons/AppIcon.icon/icon.json` defines the native Mac icon's light and
  dark appearances using the shared robot ink. macOS 26 and later select the
  appearance in Finder and the Dock, including when ChatGSD is closed. The choice
  follows macOS icon appearance settings, independently of ChatGSD's editor theme.
- `src-tauri/icons/icon.icns` remains the static fallback for older macOS versions.
  `icon-light.icns` is the matching standalone light alternative.
- `src/assets/agent-face.png` is the inline robot's empty head, ears and antenna.
  Its mask uses the theme's text color; SVG eyes and mouth retain expressions,
  pointer attention and activity animations, including reduced-motion behavior.
- The README and browser favicon select light or dark artwork by system appearance.

Generate icon sizes with `npm run tauri icon -- app-icon.png --output <directory>`.
Repeat with `app-icon-light.png` for the light set. Copy the desktop outputs into
`src-tauri/icons/`; use the 256px PNGs in `docs/` and the 32px PNGs in `public/`.

The macOS build hook runs `node scripts/prepare-macos-icon.mjs` with Xcode 26 or
later. It stages the Icon Composer descriptor with `public/gsd-robot.png`, compiles
`Assets.car`, and verifies both native appearance renditions. Tauri includes this
catalog at the bundle resource root and merges `CFBundleIconName` from
`src-tauri/Info.plist`. The release workflow repeats the catalog check against the
signed bundle before publishing. Generated catalogs stay out of Git.

Generation brief: a little seated robot checking the last item in a spiral
notebook, drawn in thin, slightly irregular white ink on warm near-black.
Preserve the tilted rounded head, dot eyes, tiny mouth, antenna, pencil and feet.
For the light icon, use charcoal ink on ivory. Keep the same pose and line style,
with transparent space outside the rounded-square tile.
