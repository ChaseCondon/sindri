/**
 * patch-theme-coverage.ts
 * Adds `terminal`, `diff`, `find`, `diagnostic`, and `syntaxExtended` sections
 * to all theme JSON files. Safe to re-run — skips files that already have them.
 *
 * Run from sindri-ide/:  bun run scripts/patch-theme-coverage.ts
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = new URL("..", import.meta.url).pathname;

interface ThemeExtension {
  terminal: Record<string, string>;
  diff: { added: string; modified: string; deleted: string };
  find: { match: string; matchHighlight: string; wordHighlight: string };
  diagnostic: { error: string; warning: string; info: string };
  syntaxExtended: Record<string, { color: string; fontStyle?: string }>;
}

const EXTENSIONS: Record<string, ThemeExtension> = {
  "sindri-dark": {
    terminal: {
      black: "#181D2A", red: "#E06C75", green: "#65C2A5", yellow: "#E0AF68",
      blue: "#5BA9FF", magenta: "#9898E0", cyan: "#4EC9D4", white: "#CDD3DE",
      brightBlack: "#3A4558", brightRed: "#FF8090", brightGreen: "#85D9BC",
      brightYellow: "#FFD080", brightBlue: "#88BFFF", brightMagenta: "#B8B8F0",
      brightCyan: "#6EDADF", brightWhite: "#E8ECF0",
    },
    diff: { added: "rgba(101,194,165,0.12)", modified: "rgba(91,169,255,0.12)", deleted: "rgba(224,108,117,0.14)" },
    find: { match: "rgba(91,169,255,0.35)", matchHighlight: "rgba(91,169,255,0.20)", wordHighlight: "rgba(91,169,255,0.15)" },
    diagnostic: { error: "#E06C75", warning: "#E0AF68", info: "#5BA9FF" },
    syntaxExtended: {
      class: { color: "#4EC9D4" }, interface: { color: "#4EC9D4" }, enum: { color: "#4EC9D4" },
      namespace: { color: "#7AB8CC" }, decorator: { color: "#65C2A5" },
      constant: { color: "#7AB8CC" }, macro: { color: "#9898E0" }, typeParameter: { color: "#4EC9D4" },
    },
  },
  "sindri-light": {
    terminal: {
      black: "#1B2230", red: "#D32F2F", green: "#1A7A5C", yellow: "#B57614",
      blue: "#2E6FD6", magenta: "#4848B8", cyan: "#007A8A", white: "#6B7585",
      brightBlack: "#525B6D", brightRed: "#C62828", brightGreen: "#2E7D32",
      brightYellow: "#F57F17", brightBlue: "#1565C0", brightMagenta: "#4527A0",
      brightCyan: "#006064", brightWhite: "#9DA5B4",
    },
    diff: { added: "rgba(26,122,92,0.10)", modified: "rgba(46,111,214,0.10)", deleted: "rgba(211,47,47,0.12)" },
    find: { match: "rgba(46,111,214,0.30)", matchHighlight: "rgba(46,111,214,0.15)", wordHighlight: "rgba(46,111,214,0.12)" },
    diagnostic: { error: "#D32F2F", warning: "#B57614", info: "#2E6FD6" },
    syntaxExtended: {
      class: { color: "#007A8A" }, interface: { color: "#007A8A" }, enum: { color: "#007A8A" },
      namespace: { color: "#1A7090" }, decorator: { color: "#1A7A5C" },
      constant: { color: "#1A7090" }, macro: { color: "#4848B8" }, typeParameter: { color: "#007A8A" },
    },
  },
  "sindri-void": {
    terminal: {
      black: "#141924", red: "#C95F6A", green: "#57B598", yellow: "#C0A060",
      blue: "#3E85E8", magenta: "#8A8AD8", cyan: "#3BB8C4", white: "#BEC5D2",
      brightBlack: "#2E3A4E", brightRed: "#E07880", brightGreen: "#77CCAA",
      brightYellow: "#D8B870", brightBlue: "#6AA8F8", brightMagenta: "#AAAAEC",
      brightCyan: "#5ACAD4", brightWhite: "#D5DAE5",
    },
    diff: { added: "rgba(87,181,152,0.12)", modified: "rgba(62,133,232,0.12)", deleted: "rgba(201,95,106,0.14)" },
    find: { match: "rgba(62,133,232,0.35)", matchHighlight: "rgba(62,133,232,0.20)", wordHighlight: "rgba(62,133,232,0.15)" },
    diagnostic: { error: "#C95F6A", warning: "#C0A060", info: "#3E85E8" },
    syntaxExtended: {
      class: { color: "#3BB8C4" }, interface: { color: "#3BB8C4" }, enum: { color: "#3BB8C4" },
      namespace: { color: "#6AAEC0" }, decorator: { color: "#57B598" },
      constant: { color: "#6AAEC0" }, macro: { color: "#8A8AD8" }, typeParameter: { color: "#3BB8C4" },
    },
  },
  "sindri-aurora-dark": {
    terminal: {
      black: "#16141f", red: "#FF5A6E", green: "#4ED9A0", yellow: "#F5C542",
      blue: "#79B8FF", magenta: "#C490FF", cyan: "#24C8D8", white: "#C5BDDC",
      brightBlack: "#3E3460", brightRed: "#FF7585", brightGreen: "#6BEDB8",
      brightYellow: "#FFD76E", brightBlue: "#99CCFF", brightMagenta: "#D4A8FF",
      brightCyan: "#4ED9E8", brightWhite: "#E8E4F0",
    },
    diff: { added: "rgba(78,217,160,0.12)", modified: "rgba(176,108,255,0.12)", deleted: "rgba(255,90,110,0.14)" },
    find: { match: "rgba(176,108,255,0.35)", matchHighlight: "rgba(176,108,255,0.20)", wordHighlight: "rgba(176,108,255,0.15)" },
    diagnostic: { error: "#FF5A6E", warning: "#F5C542", info: "#B06CFF" },
    syntaxExtended: {
      class: { color: "#D4A8FF" }, interface: { color: "#D4A8FF" }, enum: { color: "#D4A8FF" },
      namespace: { color: "#79B8FF" }, decorator: { color: "#00D4B4" },
      constant: { color: "#79B8FF" }, macro: { color: "#C490FF" }, typeParameter: { color: "#D4A8FF" },
    },
  },
  "sindri-catppuccin-latte": {
    terminal: {
      black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
      blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
      brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b",
      brightYellow: "#df8e1d", brightBlue: "#1e66f5", brightMagenta: "#ea76cb",
      brightCyan: "#179299", brightWhite: "#bcc0cc",
    },
    diff: { added: "rgba(64,160,43,0.10)", modified: "rgba(136,57,239,0.10)", deleted: "rgba(210,15,57,0.12)" },
    find: { match: "rgba(136,57,239,0.30)", matchHighlight: "rgba(136,57,239,0.15)", wordHighlight: "rgba(136,57,239,0.10)" },
    diagnostic: { error: "#d20f39", warning: "#df8e1d", info: "#1e66f5" },
    syntaxExtended: {
      class: { color: "#04a5e5" }, interface: { color: "#04a5e5" }, enum: { color: "#04a5e5" },
      namespace: { color: "#179299" }, decorator: { color: "#fe640b" },
      constant: { color: "#fe640b" }, macro: { color: "#8839ef" }, typeParameter: { color: "#04a5e5" },
    },
  },
  "sindri-catppuccin-mocha": {
    terminal: {
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
    diff: { added: "rgba(166,227,161,0.12)", modified: "rgba(203,166,247,0.12)", deleted: "rgba(243,139,168,0.14)" },
    find: { match: "rgba(203,166,247,0.35)", matchHighlight: "rgba(203,166,247,0.20)", wordHighlight: "rgba(203,166,247,0.15)" },
    diagnostic: { error: "#f38ba8", warning: "#f9e2af", info: "#89b4fa" },
    syntaxExtended: {
      class: { color: "#89dceb" }, interface: { color: "#89dceb" }, enum: { color: "#89dceb" },
      namespace: { color: "#94e2d5" }, decorator: { color: "#fab387" },
      constant: { color: "#fab387" }, macro: { color: "#cba6f7" }, typeParameter: { color: "#89dceb" },
    },
  },
  "sindri-dracula": {
    terminal: {
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#6272a4", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
      brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
      brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
    diff: { added: "rgba(80,250,123,0.12)", modified: "rgba(189,147,249,0.12)", deleted: "rgba(255,85,85,0.14)" },
    find: { match: "rgba(189,147,249,0.40)", matchHighlight: "rgba(189,147,249,0.22)", wordHighlight: "rgba(189,147,249,0.15)" },
    diagnostic: { error: "#ff5555", warning: "#ffb86c", info: "#8be9fd" },
    syntaxExtended: {
      class: { color: "#8be9fd" }, interface: { color: "#8be9fd" }, enum: { color: "#8be9fd" },
      namespace: { color: "#50fa7b" }, decorator: { color: "#50fa7b" },
      constant: { color: "#bd93f9" }, macro: { color: "#ff79c6" }, typeParameter: { color: "#8be9fd" },
    },
  },
  "sindri-github-dark": {
    terminal: {
      black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#e3b341",
      blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
      brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd", brightWhite: "#ecf2f8",
    },
    diff: { added: "rgba(63,185,80,0.12)", modified: "rgba(88,166,255,0.12)", deleted: "rgba(248,81,73,0.14)" },
    find: { match: "rgba(88,166,255,0.35)", matchHighlight: "rgba(88,166,255,0.20)", wordHighlight: "rgba(88,166,255,0.15)" },
    diagnostic: { error: "#f85149", warning: "#e3b341", info: "#58a6ff" },
    syntaxExtended: {
      class: { color: "#ffa657" }, interface: { color: "#ffa657" }, enum: { color: "#ffa657" },
      namespace: { color: "#79c0ff" }, decorator: { color: "#7ee787" },
      constant: { color: "#79c0ff" }, macro: { color: "#ff7b72" }, typeParameter: { color: "#ffa657" },
    },
  },
  "sindri-github-light": {
    terminal: {
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
      blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37",
      brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f9",
      brightCyan: "#3192aa", brightWhite: "#8c959f",
    },
    diff: { added: "rgba(17,99,41,0.10)", modified: "rgba(9,105,218,0.10)", deleted: "rgba(207,34,46,0.12)" },
    find: { match: "rgba(9,105,218,0.25)", matchHighlight: "rgba(9,105,218,0.12)", wordHighlight: "rgba(9,105,218,0.10)" },
    diagnostic: { error: "#cf222e", warning: "#9a6700", info: "#0969da" },
    syntaxExtended: {
      class: { color: "#953800" }, interface: { color: "#953800" }, enum: { color: "#953800" },
      namespace: { color: "#0550ae" }, decorator: { color: "#116329" },
      constant: { color: "#0550ae" }, macro: { color: "#cf222e" }, typeParameter: { color: "#953800" },
    },
  },
  "sindri-gruvbox-dark": {
    terminal: {
      black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
      blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
      brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26",
      brightYellow: "#fabd2f", brightBlue: "#83a598", brightMagenta: "#d3869b",
      brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
    },
    diff: { added: "rgba(152,151,26,0.14)", modified: "rgba(250,189,47,0.12)", deleted: "rgba(204,36,29,0.15)" },
    find: { match: "rgba(250,189,47,0.40)", matchHighlight: "rgba(250,189,47,0.22)", wordHighlight: "rgba(250,189,47,0.15)" },
    diagnostic: { error: "#fb4934", warning: "#fabd2f", info: "#83a598" },
    syntaxExtended: {
      class: { color: "#fabd2f" }, interface: { color: "#fabd2f" }, enum: { color: "#fabd2f" },
      namespace: { color: "#8ec07c" }, decorator: { color: "#8ec07c" },
      constant: { color: "#d3869b" }, macro: { color: "#fb4934" }, typeParameter: { color: "#fabd2f" },
    },
  },
  "sindri-gruvbox-light": {
    terminal: {
      black: "#fbf1c7", red: "#9d0006", green: "#79740e", yellow: "#b57614",
      blue: "#076678", magenta: "#8f3f71", cyan: "#427b58", white: "#3c3836",
      brightBlack: "#bdae93", brightRed: "#cc241d", brightGreen: "#98971a",
      brightYellow: "#d79921", brightBlue: "#458588", brightMagenta: "#b16286",
      brightCyan: "#689d6a", brightWhite: "#282828",
    },
    diff: { added: "rgba(121,116,14,0.10)", modified: "rgba(181,118,20,0.10)", deleted: "rgba(157,0,6,0.12)" },
    find: { match: "rgba(181,118,20,0.25)", matchHighlight: "rgba(181,118,20,0.12)", wordHighlight: "rgba(181,118,20,0.10)" },
    diagnostic: { error: "#9d0006", warning: "#b57614", info: "#076678" },
    syntaxExtended: {
      class: { color: "#b57614" }, interface: { color: "#b57614" }, enum: { color: "#b57614" },
      namespace: { color: "#427b58" }, decorator: { color: "#427b58" },
      constant: { color: "#8f3f71" }, macro: { color: "#9d0006" }, typeParameter: { color: "#b57614" },
    },
  },
  "sindri-nord": {
    terminal: {
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
    diff: { added: "rgba(163,190,140,0.12)", modified: "rgba(136,192,208,0.12)", deleted: "rgba(191,97,106,0.14)" },
    find: { match: "rgba(136,192,208,0.35)", matchHighlight: "rgba(136,192,208,0.20)", wordHighlight: "rgba(136,192,208,0.15)" },
    diagnostic: { error: "#bf616a", warning: "#ebcb8b", info: "#81a1c1" },
    syntaxExtended: {
      class: { color: "#8fbcbb" }, interface: { color: "#8fbcbb" }, enum: { color: "#8fbcbb" },
      namespace: { color: "#88c0d0" }, decorator: { color: "#ebcb8b" },
      constant: { color: "#b48ead" }, macro: { color: "#81a1c1" }, typeParameter: { color: "#8fbcbb" },
    },
  },
  "sindri-one-dark-pro": {
    terminal: {
      black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
      brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
      brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
    diff: { added: "rgba(152,195,121,0.12)", modified: "rgba(97,175,239,0.12)", deleted: "rgba(224,108,117,0.14)" },
    find: { match: "rgba(97,175,239,0.35)", matchHighlight: "rgba(97,175,239,0.20)", wordHighlight: "rgba(97,175,239,0.15)" },
    diagnostic: { error: "#e06c75", warning: "#e5c07b", info: "#61afef" },
    syntaxExtended: {
      class: { color: "#e5c07b" }, interface: { color: "#e5c07b" }, enum: { color: "#e5c07b" },
      namespace: { color: "#56b6c2" }, decorator: { color: "#d19a66" },
      constant: { color: "#d19a66" }, macro: { color: "#c678dd" }, typeParameter: { color: "#e5c07b" },
    },
  },
  "sindri-rose-pine": {
    terminal: {
      black: "#26233a", red: "#eb6f92", green: "#31748f", yellow: "#f6c177",
      blue: "#9ccfd8", magenta: "#c4a7e7", cyan: "#ebbcba", white: "#e0def4",
      brightBlack: "#6e6a86", brightRed: "#eb6f92", brightGreen: "#31748f",
      brightYellow: "#f6c177", brightBlue: "#9ccfd8", brightMagenta: "#c4a7e7",
      brightCyan: "#ebbcba", brightWhite: "#e0def4",
    },
    diff: { added: "rgba(49,116,143,0.12)", modified: "rgba(196,167,231,0.12)", deleted: "rgba(235,111,146,0.14)" },
    find: { match: "rgba(196,167,231,0.35)", matchHighlight: "rgba(196,167,231,0.20)", wordHighlight: "rgba(196,167,231,0.15)" },
    diagnostic: { error: "#eb6f92", warning: "#f6c177", info: "#9ccfd8" },
    syntaxExtended: {
      class: { color: "#c4a7e7" }, interface: { color: "#c4a7e7" }, enum: { color: "#c4a7e7" },
      namespace: { color: "#9ccfd8" }, decorator: { color: "#f6c177" },
      constant: { color: "#f6c177" }, macro: { color: "#31748f" }, typeParameter: { color: "#c4a7e7" },
    },
  },
  "sindri-rose-pine-dawn": {
    terminal: {
      black: "#575279", red: "#b4637a", green: "#286983", yellow: "#ea9d34",
      blue: "#56949f", magenta: "#907aa9", cyan: "#d7827e", white: "#575279",
      brightBlack: "#9893a5", brightRed: "#b4637a", brightGreen: "#286983",
      brightYellow: "#ea9d34", brightBlue: "#56949f", brightMagenta: "#907aa9",
      brightCyan: "#d7827e", brightWhite: "#575279",
    },
    diff: { added: "rgba(40,105,131,0.10)", modified: "rgba(144,122,169,0.10)", deleted: "rgba(180,99,122,0.12)" },
    find: { match: "rgba(144,122,169,0.25)", matchHighlight: "rgba(144,122,169,0.12)", wordHighlight: "rgba(144,122,169,0.10)" },
    diagnostic: { error: "#b4637a", warning: "#ea9d34", info: "#56949f" },
    syntaxExtended: {
      class: { color: "#907aa9" }, interface: { color: "#907aa9" }, enum: { color: "#907aa9" },
      namespace: { color: "#56949f" }, decorator: { color: "#ea9d34" },
      constant: { color: "#ea9d34" }, macro: { color: "#286983" }, typeParameter: { color: "#907aa9" },
    },
  },
  "sindri-solarized-dark": {
    terminal: {
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
      brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
    diff: { added: "rgba(133,153,0,0.14)", modified: "rgba(38,139,210,0.12)", deleted: "rgba(220,50,47,0.14)" },
    find: { match: "rgba(38,139,210,0.35)", matchHighlight: "rgba(38,139,210,0.20)", wordHighlight: "rgba(38,139,210,0.15)" },
    diagnostic: { error: "#dc322f", warning: "#b58900", info: "#268bd2" },
    syntaxExtended: {
      class: { color: "#b58900" }, interface: { color: "#b58900" }, enum: { color: "#b58900" },
      namespace: { color: "#2aa198" }, decorator: { color: "#2aa198" },
      constant: { color: "#2aa198" }, macro: { color: "#859900" }, typeParameter: { color: "#b58900" },
    },
  },
  "sindri-solarized-light": {
    terminal: {
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#fdf6e3",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
      brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1", brightWhite: "#eee8d5",
    },
    diff: { added: "rgba(133,153,0,0.10)", modified: "rgba(38,139,210,0.10)", deleted: "rgba(220,50,47,0.12)" },
    find: { match: "rgba(38,139,210,0.25)", matchHighlight: "rgba(38,139,210,0.12)", wordHighlight: "rgba(38,139,210,0.10)" },
    diagnostic: { error: "#dc322f", warning: "#b58900", info: "#268bd2" },
    syntaxExtended: {
      class: { color: "#b58900" }, interface: { color: "#b58900" }, enum: { color: "#b58900" },
      namespace: { color: "#2aa198" }, decorator: { color: "#2aa198" },
      constant: { color: "#2aa198" }, macro: { color: "#859900" }, typeParameter: { color: "#b58900" },
    },
  },
  "sindri-tokyo-night": {
    terminal: {
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
      brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
    diff: { added: "rgba(158,206,106,0.12)", modified: "rgba(122,162,247,0.12)", deleted: "rgba(247,118,142,0.14)" },
    find: { match: "rgba(122,162,247,0.35)", matchHighlight: "rgba(122,162,247,0.20)", wordHighlight: "rgba(122,162,247,0.15)" },
    diagnostic: { error: "#f7768e", warning: "#e0af68", info: "#7aa2f7" },
    syntaxExtended: {
      class: { color: "#0db9d7" }, interface: { color: "#0db9d7" }, enum: { color: "#0db9d7" },
      namespace: { color: "#73daca" }, decorator: { color: "#9ece6a" },
      constant: { color: "#ff9e64" }, macro: { color: "#bb9af7" }, typeParameter: { color: "#0db9d7" },
    },
  },
  "sindri-tokyo-night-storm": {
    terminal: {
      black: "#1d202f", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
      brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
    diff: { added: "rgba(158,206,106,0.12)", modified: "rgba(122,162,247,0.12)", deleted: "rgba(247,118,142,0.14)" },
    find: { match: "rgba(122,162,247,0.35)", matchHighlight: "rgba(122,162,247,0.20)", wordHighlight: "rgba(122,162,247,0.15)" },
    diagnostic: { error: "#f7768e", warning: "#e0af68", info: "#7aa2f7" },
    syntaxExtended: {
      class: { color: "#0db9d7" }, interface: { color: "#0db9d7" }, enum: { color: "#0db9d7" },
      namespace: { color: "#73daca" }, decorator: { color: "#9ece6a" },
      constant: { color: "#ff9e64" }, macro: { color: "#bb9af7" }, typeParameter: { color: "#0db9d7" },
    },
  },
};

// Map theme ID → file path
const THEME_FILES: [string, string][] = [
  ["sindri-dark",            path.join(ROOT, "core-extensions/sindri-dark/dark.json")],
  ["sindri-light",           path.join(ROOT, "core-extensions/sindri-light/light.json")],
  ["sindri-void",            path.join(ROOT, "core-extensions/sindri-void/void.json")],
  ["sindri-aurora-dark",     path.join(ROOT, "../sindri-extensions/aurora-theme-pack/aurora-theme/aurora-dark.json")],
  ["sindri-catppuccin-latte",  path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-catppuccin-latte/sindri-catppuccin-latte-color/catppuccin-latte.json")],
  ["sindri-catppuccin-mocha",  path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-catppuccin-mocha/sindri-catppuccin-mocha-color/catppuccin-mocha.json")],
  ["sindri-dracula",           path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-dracula/sindri-dracula-color/dracula.json")],
  ["sindri-github-dark",       path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-github-dark/sindri-github-dark-color/github-dark.json")],
  ["sindri-github-light",      path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-github-light/sindri-github-light-color/github-light.json")],
  ["sindri-gruvbox-dark",      path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-gruvbox-dark/sindri-gruvbox-dark-color/gruvbox-dark.json")],
  ["sindri-gruvbox-light",     path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-gruvbox-light/sindri-gruvbox-light-color/gruvbox-light.json")],
  ["sindri-nord",              path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-nord/sindri-nord-color/nord.json")],
  ["sindri-one-dark-pro",      path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-one-dark-pro/sindri-one-dark-pro-color/one-dark-pro.json")],
  ["sindri-rose-pine",         path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-rose-pine/sindri-rose-pine-color/rose-pine.json")],
  ["sindri-rose-pine-dawn",    path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-rose-pine-dawn/sindri-rose-pine-dawn-color/rose-pine-dawn.json")],
  ["sindri-solarized-dark",    path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-solarized-dark/sindri-solarized-dark-color/solarized-dark.json")],
  ["sindri-solarized-light",   path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-solarized-light/sindri-solarized-light-color/solarized-light.json")],
  ["sindri-tokyo-night",       path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-tokyo-night/sindri-tokyo-night-color/tokyo-night.json")],
  ["sindri-tokyo-night-storm", path.join(ROOT, "../sindri-extensions/community-theme-collection/sindri-tokyo-night-storm/sindri-tokyo-night-storm-color/tokyo-night-storm.json")],
];

let patched = 0, skipped = 0;

for (const [id, filePath] of THEME_FILES) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  skip (not found): ${filePath}`);
    skipped++;
    continue;
  }
  const ext = EXTENSIONS[id];
  if (!ext) {
    console.warn(`  skip (no extension data): ${id}`);
    skipped++;
    continue;
  }
  const theme = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (theme.terminal) {
    console.log(`  already patched: ${id}`);
    skipped++;
    continue;
  }
  theme.terminal       = ext.terminal;
  theme.diff           = ext.diff;
  theme.find           = ext.find;
  theme.diagnostic     = ext.diagnostic;
  theme.syntaxExtended = ext.syntaxExtended;
  fs.writeFileSync(filePath, JSON.stringify(theme, null, 2) + "\n");
  console.log(`  ✓ patched: ${id}`);
  patched++;
}

console.log(`\nDone — ${patched} patched, ${skipped} skipped.`);
