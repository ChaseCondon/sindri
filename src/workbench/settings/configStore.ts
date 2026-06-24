// Extension configuration store — ADR-0023
// Flat override-only map (sindri:config) over merged extension schemas.
// Using solid-js/store makes get() reactive in SolidJS component contexts.
import { createStore, produce } from "solid-js/store";
import type { ConfigurationSchema, ConfigurationField, ConfigurationContribution } from "../../extensions/manifest";

const CONFIG_KEY = "sindri:config";
const LEGACY_KEY = "sindri:settings";
// Bump when the settings schema has a breaking change. On mismatch the stored
// config is discarded and rebuilt from legacy+defaults, clearing accidental writes.
const CONFIG_VERSION = 1;

type ConfigOverrides = Record<string, unknown>;

// --- Schema registry (populated at module init + installExtension calls) ---
const _schema = new Map<string, ConfigurationField>();
const _contributions = new Map<string, ConfigurationContribution>();

// --- Override store (SolidJS reactive — get() is tracked in component contexts) ---
const [_overrides, _setOverrides] = createStore<ConfigOverrides>(loadAndMigrateOverrides());

// --- Imperative change emitter (for decoration-registry, non-Solid consumers) ---
const _changeHandlers = new Set<(keys: string[]) => void>();

// ---------------------------------------------------------------------------
// Built-in schema: sindri.editor-decorations (mirrors core-extensions manifest)
// ---------------------------------------------------------------------------

export const EDITOR_DECORATIONS_SCHEMA: ConfigurationSchema = {
  "editor.rainbowBrackets": {
    type: "boolean",
    default: true,
    groupTitle: "Rainbow Brackets",
    title: "Enabled",
    description: "Colour bracket pairs by nesting depth using a 6-level colour cycle.",
    order: 0,
  },
  "editor.rainbowBrackets.opacity": {
    type: "number",
    default: 1,
    title: "Opacity",
    description: "Visibility of rainbow bracket colours (0 = invisible, 1 = full).",
    minimum: 0.05,
    maximum: 1,
    step: 0.05,
    presentation: "range",
    order: 1,
  },
  "editor.indentGuides.enabled": {
    type: "boolean",
    default: true,
    groupTitle: "Indent Guides",
    title: "Enabled",
    description: "Show vertical guide lines at each indentation level.",
    order: 2,
  },
  "editor.indentGuides.style": {
    type: "enum",
    default: "monochrome",
    title: "Style",
    description: "Style of the indent guide lines.",
    enum: ["monochrome", "rainbow"],
    enumLabels: ["Monochrome", "Rainbow"],
    presentation: "radio",
    order: 3,
  },
  "editor.indentGuides.opacity": {
    type: "number",
    default: 0.5,
    title: "Opacity",
    description: "Visibility of indent guide lines (0 = invisible, 1 = full).",
    minimum: 0.05,
    maximum: 1,
    step: 0.05,
    presentation: "range",
    order: 4,
  },
  "editor.fontFamily": {
    type: "string",
    default: "",
    groupTitle: "Font",
    title: "Font family",
    description: "Monospace font for the editor. Leave empty for the default stack.",
    order: 5,
  },
  "editor.fontLigatures": {
    type: "boolean",
    default: true,
    title: "Font ligatures",
    description: "Render programming ligatures (e.g. => != ===) if the font provides them.",
    order: 6,
  },
};

// ── Built-in schema: sindri.general ─────────────────────────────────────────

export const GENERAL_SCHEMA: ConfigurationSchema = {
  "editor.autoSave": {
    type: "boolean",
    default: false,
    groupTitle: "Saving",
    title: "Auto save",
    description: "Automatically save files after a short delay when edited. When disabled, save manually with ⌘S / Ctrl+S.",
    order: 1,
  },
  "editor.autoSaveDelay": {
    type: "number",
    default: 1500,
    title: "Auto save delay (ms)",
    description: "Milliseconds to wait after the last keystroke before auto-saving.",
    minimum: 200,
    maximum: 10000,
    step: 100,
    presentation: "range",
    when: "editor.autoSave",
    order: 2,
  },
};

registerSchemas("sindri.general", {
  navSection: { group: "General", label: "Editor", order: 1 },
  schema: GENERAL_SCHEMA,
});

// Register at module init so get() works before App mounts.
registerSchemas("sindri.editor-decorations", {
  navSection: { group: "Appearance", label: "Editor", order: 1 },
  schema: EDITOR_DECORATIONS_SCHEMA,
});

// ---------------------------------------------------------------------------
// Built-in schema: sindri.terminal
// ---------------------------------------------------------------------------

export const TERMINAL_SCHEMA: ConfigurationSchema = {
  // ── Appearance ────────────────────────────────────────────────────────────
  // By default the terminal follows the active Sindri UI theme. Opt in to a
  // separate scheme via terminal.customTheme + terminal.colorScheme.
  "terminal.customTheme": {
    type: "boolean",
    default: false,
    groupTitle: "Appearance",
    title: "Use a separate color scheme",
    description: "Pick a terminal color scheme independent of the app theme.",
    order: 0,
  },
  "terminal.colorScheme": {
    type: "string",
    default: "",
    title: "Color scheme",
    description: "Installed theme to use for terminal colors.",
    order: 1,
  },
  "terminal.fontSize": {
    type: "number",
    default: 13,
    title: "Font size",
    description: "Terminal font size in pixels.",
    minimum: 8,
    maximum: 32,
    step: 1,
    order: 2,
  },
  "terminal.fontFamily": {
    type: "string",
    default: "monospace",
    title: "Font family",
    description: "CSS font-family string. The font must be installed on your system.",
    order: 2,
  },
  "terminal.lineHeight": {
    type: "number",
    default: 1.2,
    title: "Line height",
    description: "Line height multiplier.",
    minimum: 1.0,
    maximum: 2.0,
    step: 0.05,
    order: 3,
  },
  "terminal.letterSpacing": {
    type: "number",
    default: 0,
    title: "Letter spacing",
    description: "Extra horizontal spacing between characters, in pixels.",
    minimum: -2,
    maximum: 8,
    step: 0.5,
    order: 4,
  },
  "terminal.fontLigatures": {
    type: "boolean",
    default: false,
    title: "Font ligatures",
    description: "Render programming ligatures (e.g. => != ===) if the font provides them.",
    order: 5,
  },
  // ── Cursor ────────────────────────────────────────────────────────────────
  "terminal.cursorStyle": {
    type: "enum",
    default: "block",
    groupTitle: "Cursor",
    title: "Cursor style",
    enum: ["block", "bar", "underline"],
    enumLabels: ["Block", "Bar", "Underline"],
    presentation: "radio",
    order: 5,
  },
  "terminal.cursorBlink": {
    type: "boolean",
    default: true,
    title: "Cursor blink",
    description: "Animate the cursor.",
    order: 6,
  },
  // ── Behavior ──────────────────────────────────────────────────────────────
  "terminal.scrollback": {
    type: "number",
    default: 1000,
    groupTitle: "Behavior",
    title: "Scrollback lines",
    description: "Number of lines kept in the scrollback buffer (0 = unlimited).",
    minimum: 0,
    maximum: 100000,
    step: 500,
    order: 7,
  },
  "terminal.shell": {
    type: "string",
    default: "",
    title: "Shell",
    description: "Path to the shell binary. Leave empty to auto-detect ($SHELL or platform default).",
    order: 8,
  },
  "terminal.cwd": {
    type: "enum",
    default: "workspace",
    title: "Starting directory",
    description: "Where new terminal sessions open.",
    enum: ["workspace", "home"],
    enumLabels: ["Project folder", "Home directory"],
    presentation: "radio",
    order: 9,
  },
  "terminal.copyOnSelect": {
    type: "boolean",
    default: false,
    title: "Copy on select",
    description: "Automatically copy selected text to the clipboard.",
    order: 10,
  },
  "terminal.bell": {
    type: "boolean",
    default: false,
    title: "Enable bell",
    description: "Play an audio bell on BEL character (\\x07).",
    order: 11,
  },
  "terminal.macOptionAsAlt": {
    type: "boolean",
    default: false,
    title: "Option key as Alt",
    description: "Treat the macOS Option key as Alt, enabling alt-key sequences in programs like vim and tmux.",
    order: 12,
  },
};

registerSchemas("sindri.terminal", {
  navSection: { group: "Appearance", label: "Terminal", order: 2 },
  schema: TERMINAL_SCHEMA,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerSchemas(extensionId: string, contribution: ConfigurationContribution): void {
  _contributions.set(extensionId, contribution);
  for (const [k, v] of Object.entries(contribution.schema)) {
    _schema.set(k, v);
  }
}

/** Resolved value: override → schema default. Reactive in SolidJS contexts. */
export function get<T>(key: string): T {
  const override = _overrides[key];
  if (override !== undefined) return override as T;
  const field = _schema.get(key);
  if (field !== undefined) return field.default as T;
  throw new Error(`[configStore] Unknown config key: "${key}"`);
}

/** Write an override. Removes the key if value equals the schema default. Emits change. */
export function set(key: string, value: unknown): void {
  const field = _schema.get(key);
  if (field !== undefined && value === field.default) {
    _setOverrides(produce((o: ConfigOverrides) => { delete o[key]; }));
  } else {
    _setOverrides(key, value);
  }
  persist();
  emit([key]);
}

export function schemaFor(key: string): ConfigurationField | undefined {
  return _schema.get(key);
}

/** Returns all registered configuration contributions (extensionId → contribution). */
export function allContributions(): ReadonlyMap<string, ConfigurationContribution> {
  return _contributions;
}

/** Register an imperative change handler (for non-Solid consumers like decoration-registry). */
export function onDidChange(handler: (keys: string[]) => void): () => void {
  _changeHandlers.add(handler);
  return () => _changeHandlers.delete(handler);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function loadAndMigrateOverrides(): ConfigOverrides {
  const result: ConfigOverrides = {};

  // Load current config store — only if version matches; otherwise start fresh.
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ConfigOverrides & { __v?: number };
      if (parsed.__v === CONFIG_VERSION) {
        delete parsed.__v;
        Object.assign(result, parsed);
      }
      // version mismatch or missing → ignore old store, fall through to legacy migration
    }
  } catch { /* storage unavailable or corrupt */ }

  // Lift legacy keys from sindri:settings (one-time migration, non-destructive)
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as Record<string, unknown>;
      if (legacy.rainbowBrackets !== undefined && result["editor.rainbowBrackets"] === undefined)
        result["editor.rainbowBrackets"] = legacy.rainbowBrackets;
      if (legacy.indentGuides !== undefined && result["editor.indentGuides.enabled"] === undefined)
        result["editor.indentGuides.enabled"] = legacy.indentGuides;
      if (legacy.indentGuideStyle !== undefined && result["editor.indentGuides.style"] === undefined)
        result["editor.indentGuides.style"] = legacy.indentGuideStyle;
    }
  } catch { /* ignore legacy parse failure */ }

  console.log("[configStore] loadAndMigrateOverrides →", JSON.stringify(result));
  return result;
}

function persist(): void {
  try {
    const toSave: Record<string, unknown> = { __v: CONFIG_VERSION };
    for (const [k, v] of Object.entries(_overrides)) {
      if (v !== undefined) toSave[k] = v;
    }
    localStorage.setItem(CONFIG_KEY, JSON.stringify(toSave));
  } catch { /* storage unavailable */ }
}

export function emit(keys: string[]): void {
  for (const h of _changeHandlers) h(keys);
}
