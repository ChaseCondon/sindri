import type { ITheme } from "@xterm/xterm";
import type { ThemeDef } from "../../theme/tokens";
import { themeList, uiThemeId } from "../../theme/registry";
import { get } from "../settings/configStore";

// Neutral ANSI 16-color palette for themes that don't define their own.
const FALLBACK_ANSI = {
  black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
  blue: "#89b4fa", magenta: "#cba6f7", cyan: "#94e2d5", white: "#bac2de",
  brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
  brightBlue: "#89b4fa", brightMagenta: "#cba6f7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
};

/** Build an xterm ITheme from a Sindri ThemeDef (editor surface + ANSI palette). */
export function xtermThemeFromDef(def: ThemeDef): ITheme {
  const ansi = def.terminal ?? FALLBACK_ANSI;
  const bg = def.editor.bg;
  const fg = def.editor.fg;
  return {
    background: bg,
    foreground: fg,
    cursor: def.editor.caret ?? def.ui["--accent"],
    cursorAccent: bg,
    selectionBackground: def.editor.selection,
    ...ansi,
  };
}

/** Look up a registered theme by id. */
function themeById(id: string): ThemeDef | undefined {
  return themeList().find((t) => t.id === id);
}

/**
 * Resolve the ITheme the terminal should use right now.
 *
 * Reactive: reads `terminal.customTheme` / `terminal.colorScheme` and `uiThemeId`,
 * so a `createEffect` that calls this re-runs when any of them change.
 */
export function resolveTerminalTheme(): ITheme {
  const custom = get<boolean>("terminal.customTheme");
  const id = custom ? get<string>("terminal.colorScheme") : uiThemeId();
  const def = themeById(id) ?? themeById(uiThemeId());
  return def ? xtermThemeFromDef(def) : { ...FALLBACK_ANSI, background: "#0d0f12", foreground: "#cdd6f4" };
}
