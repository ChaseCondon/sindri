// Icon theme definitions + resolution engine (ADR-0019 §4).
// Resolution order: fileNames → fileExtensions → languageIds → defaults.
// SVG data loaded from core-extensions/sindri-file-icons/ via import.meta.glob
// so this file doesn't need updating when the generator reruns.
import type { IconThemeDef, IconSource } from "../theme/tokens";
import { registerIconTheme, activeIconTheme } from "../theme/registry";
import iconsJson from "../../core-extensions/sindri-file-icons/icons.json";

// ---------------------------------------------------------------------------
// Eagerly import every generated SVG as a raw string at build time.
// Keys look like: "../../core-extensions/sindri-file-icons/icons/ts.svg"
// ---------------------------------------------------------------------------

const _svgGlob = import.meta.glob<string>(
  "../../core-extensions/sindri-file-icons/icons/*.svg",
  { eager: true, as: "raw" },
);

const icons: Record<string, IconSource> = {};
for (const [filePath, svg] of Object.entries(_svgGlob)) {
  const id = filePath.split("/").pop()!.replace(".svg", "");
  icons[id] = { svg };
}

// ---------------------------------------------------------------------------
// Theme definition — mapping tables come directly from the generated icons.json
// ---------------------------------------------------------------------------

const sindriFileIcons: IconThemeDef = {
  id:             "sindri-file-icons",
  name:           "Sindri File Icons",
  kind:           "color",
  fileExtensions: iconsJson.fileExtensions as Record<string, string>,
  fileNames:      iconsJson.fileNames      as Record<string, string>,
  folderNames:    iconsJson.folderNames    as Record<string, string>,
  defaults:       iconsJson.defaults       as { file: string; folder: string; folderOpen: string },
  icons,
};

export function registerBuiltinIconThemes(): void {
  registerIconTheme(sindriFileIcons);
}

// ---------------------------------------------------------------------------
// Resolution engine — call this from FileExplorer
// ---------------------------------------------------------------------------

export function resolveIconSvg(
  name: string,
  isDir: boolean,
  isOpen = false,
): string {
  const theme = activeIconTheme();
  if (!theme) return "";

  let iconId: string | undefined;

  if (isDir) {
    const lname = name.toLowerCase();
    const baseId = theme.folderNames?.[lname] ?? theme.folderNames?.[name];
    if (baseId) {
      // Convention: open variant is <baseId>-open; fall back to base if absent.
      iconId = isOpen ? `${baseId}-open` : baseId;
      if (isOpen && !theme.icons[iconId]) iconId = baseId;
    } else {
      iconId = isOpen
        ? theme.defaults.folderOpen
        : theme.defaults.folder;
    }
  } else {
    const lname = name.toLowerCase();
    iconId =
      theme.fileNames?.[name] ??
      theme.fileNames?.[lname] ??
      undefined;

    if (!iconId) {
      const dot = lname.lastIndexOf(".");
      if (dot !== -1) {
        const ext = lname.slice(dot + 1);
        iconId = theme.fileExtensions?.[ext];
      }
    }
    iconId ??= theme.defaults.file;
  }

  const source = theme.icons[iconId];
  if (!source) return "";

  return theme.kind === "mono"
    ? (source.monoSvg ?? source.svg)
    : source.svg;
}
