// Token catalog — authoritative source is docs/design/theming.md (ADR-0019)
// Add a token here AND in every ThemeDef, never hard-code appearance values.

export type UiToken =
  | "--bg"
  | "--bg-panel"
  | "--bg-chrome"
  | "--bg-hover"
  | "--border"
  | "--border-subtle"
  | "--text"
  | "--text-dim"
  | "--accent"
  | "--accent-tint"
  | "--danger";

export type GlowToken =
  | "--glow-color"
  | "--glow-accent"
  | "--glow-accent-strong";

// CM6 surface — self-contained; must NOT reference root CSS vars (enables UI/editor split)
export type EditorToken =
  | "bg"
  | "fg"
  | "caret"
  | "selection"
  | "activeLine"
  | "gutter.bg"
  | "gutter.fg"
  | "gutter.activeFg"
  | "matchingBracket";

export type SyntaxToken =
  | "keyword"
  | "controlKeyword"
  | "string"
  | "number"
  | "bool"
  | "comment"
  | "function"
  | "type"
  | "variable"
  | "property"
  | "operator"
  | "punctuation"
  | "tag"
  | "attribute"
  | "heading"
  | "link"
  | "regexp"
  | "escape";

export interface TokenStyle {
  color: string;
  fontStyle?: "italic";
  fontWeight?: string;
}

// ---------------------------------------------------------------------------
// Extended coverage tokens — optional; recommended for full VSCode-level coverage.
// Renderers fall back gracefully when absent (e.g. terminal uses defaults).
// ---------------------------------------------------------------------------

export interface ThemeTerminal {
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface ThemeDiff {
  added: string;    // background tint for added lines
  modified: string; // background tint for modified lines
  deleted: string;  // background tint for deleted lines
}

export interface ThemeFind {
  match: string;           // current/active match highlight
  matchHighlight: string;  // other matches in the document
  wordHighlight: string;   // word-under-cursor highlight
}

export interface ThemeDiagnostic {
  error: string;   // error squiggle / gutter marker color
  warning: string; // warning squiggle / gutter marker color
  info: string;    // info squiggle / hint color
}

// Additional syntax tokens beyond the base 18 — for languages with richer grammars.
export type ExtendedSyntaxToken =
  | "class" | "interface" | "enum" | "namespace"
  | "decorator" | "constant" | "macro" | "typeParameter";

export interface ThemeDef {
  id: string;
  name: string;
  kind: "light" | "dark";
  ui: Record<UiToken, string>;
  glow: Record<GlowToken, string>;
  editor: Record<EditorToken, string>;
  syntax: Record<SyntaxToken, TokenStyle>;
  // Optional extended coverage (add these for full VSCode-parity coverage)
  terminal?: ThemeTerminal;
  diff?: ThemeDiff;
  find?: ThemeFind;
  diagnostic?: ThemeDiagnostic;
  syntaxExtended?: Partial<Record<ExtendedSyntaxToken, TokenStyle>>;
}

// ---------------------------------------------------------------------------
// Icon theme types
// ---------------------------------------------------------------------------

export type IconId = string;

export interface IconSource {
  svg: string;
  monoSvg?: string; // uses currentColor; falls back to svg in mono mode
}

// On-disk format for external extensions — references separate SVG files by path.
// The install flow resolves paths → inline strings to produce an IconThemeDef.
export interface IconSourceRef {
  path: string;      // relative to the icon theme JSON file, e.g. "icons/ts.svg"
  monoPath?: string; // optional separate mono variant
}

// UI / chrome icon pack — activity bar, dock bars, toolbar glyphs.
// Third-party packs call sindri.iconThemes.registerUiPack(manifest).
// The icons map tool-window IDs (and future UI element IDs) to SVG strings.
export interface UiIconPackDef {
  id: string;
  name: string;
  icons: Record<string, string>; // toolWindowId → inline SVG string
}

export interface IconThemeDef {
  id: string;
  name: string;
  kind: "color" | "mono";
  fileNames?: Record<string, IconId>;
  fileExtensions?: Record<string, IconId>;
  languageIds?: Record<string, IconId>;
  folderNames?: Record<string, IconId>;
  defaults: { file: IconId; folder: IconId; folderOpen: IconId };
  icons: Record<IconId, IconSource>;
  // CSS custom property overrides injected onto :root when this theme is active (ADR-0032).
  // Keys must include the leading '--' (e.g. '--folder-base': '#585b70').
  cssVars?: Record<string, string>;
  // RESERVED per ADR-0019 §4 — activity bar / dock / toolbar glyphs (not yet implemented)
  ui?: Record<string, IconSource>;
}
