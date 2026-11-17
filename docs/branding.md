# Robot artwork

The robot and icon variants were created with the built-in imagegen tool.
Keep the loose, thin pen strokes and seated checklist pose. The approved direction
is a hand-drawn character, not a geometric robot head or completion badge.

- `public/gsd-robot.png` contains only the robot's ink on transparency. The editor
  uses its alpha channel as a mask, colored with the current theme's text color.
- `app-icon.png` is the dark Mac icon source. `app-icon-light.png` is the ivory
  alternative. Both include transparent corners and margins.
- `src-tauri/icons/icon.icns` is the bundled Mac icon. `icon-light.icns` is the
  matching light alternative; the Dock icon does not switch with the app theme.
- The README and browser favicon select light or dark artwork by system appearance.

Generate icon sizes with `npm run tauri icon -- app-icon.png --output <directory>`.
Repeat with `app-icon-light.png` for the light set. Copy the desktop outputs into
`src-tauri/icons/`; use the 256px PNGs in `docs/` and the 32px PNGs in `public/`.

Generation brief: a little seated robot checking the last item in a spiral
notebook, drawn in thin, slightly irregular white ink on warm near-black.
Preserve the tilted rounded head, dot eyes, tiny mouth, antenna, pencil and feet.
For the light icon, use charcoal ink on ivory. Keep the same pose and line style,
with transparent space outside the rounded-square tile.
