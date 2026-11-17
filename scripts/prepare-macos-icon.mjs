// Compile native appearance variants before Tauri signs the macOS bundle.
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

export function validateAppearances(renditions) {
  for (const appearance of ["NSAppearanceNameAqua", "NSAppearanceNameDarkAqua"]) {
    if (!renditions.some((item) => item.Name === "AppIcon" &&
      item.AssetType === "IconImageStack" && item.Appearance === appearance)) {
      throw new Error(`AppIcon is missing its ${appearance} appearance`);
    }
  }
}

export async function verifyIconCatalog(path) {
  await run("xcrun", ["assetutil", "--validate-file", path]);
  const { stdout } = await run("xcrun", ["assetutil", "--info", path]);
  validateAppearances(JSON.parse(stdout));
}

async function prepareMacosIcon() {
  const resources = join(root, "src-tauri/resources");
  await mkdir(resources, { recursive: true });
  const stage = await mkdtemp(join(resources, ".appearance-icon-"));
  try {
    const source = join(stage, "AppIcon.icon");
    const output = join(stage, "compiled");
    await mkdir(join(source, "Assets"), { recursive: true });
    await mkdir(output);
    await copyFile(join(root, "src-tauri/icons/AppIcon.icon/icon.json"), join(source, "icon.json"));
    await copyFile(join(root, "public/gsd-robot.png"), join(source, "Assets/robot.png"));
    await run("xcrun", [
      "actool", source, "--compile", output,
      "--output-format", "human-readable-text",
      "--output-partial-info-plist", join(output, "Info.plist"),
      "--app-icon", "AppIcon", "--include-all-app-icons",
      "--target-device", "mac", "--minimum-deployment-target", "10.15",
      "--platform", "macosx",
    ]);
    const catalog = join(output, "Assets.car");
    await verifyIconCatalog(catalog);
    const destination = join(resources, "appearance-icon");
    await mkdir(destination, { recursive: true });
    await rename(catalog, join(destination, "Assets.car"));
    console.log("Mac app icon ready: native light and dark appearances");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 2) await prepareMacosIcon();
    else if (process.argv.length === 4 && process.argv[2] === "--verify") {
      await verifyIconCatalog(resolve(process.argv[3]));
      console.log("Mac app icon contains valid light and dark appearances");
    } else throw new Error("Usage: prepare-macos-icon.mjs [--verify Assets.car]");
  } catch (error) {
    console.error(error.message);
    if (error.stderr) console.error(error.stderr);
    process.exitCode = 1;
  }
}
