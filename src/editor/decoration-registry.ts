// Editor decoration registry — ADR-0024 Model A (static bundled features) + Model B (extension providers)
// Owns one Compartment per feature; builds Extensions from configStore values.
// No import from groups.ts — maintains the buffers→registry cycle-free invariant.
// applyChangedDecorations() is called from features.ts (which owns the views lookup).
import { Compartment, Prec, StateEffect, StateField, RangeSet, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { makeRainbowBrackets, DARK_COLORS, LIGHT_COLORS } from "./rainbow-brackets";
import { makeIndentGuides, type IndentGuideStyle } from "./indent-guides";
import * as configStore from "../workbench/settings/configStore";

export type { IndentGuideStyle };

function editorThemeKind(): "dark" | "light" {
  return document.documentElement.getAttribute("data-theme-kind") === "light" ? "light" : "dark";
}

interface DecorationFeature {
  readonly id: string;
  readonly compartment: Compartment;
  readonly configKeys: readonly string[];
  build(): Extension;
}

const DEFAULT_EDITOR_FONT =
  "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace";

const DECORATION_FEATURES: DecorationFeature[] = [
  {
    id: "editor-font",
    compartment: new Compartment(),
    configKeys: ["editor.fontFamily", "editor.fontLigatures"],
    build() {
      const family = (configStore.get<string>("editor.fontFamily") ?? "").trim();
      const stack = family ? `"${family}", ${DEFAULT_EDITOR_FONT}` : DEFAULT_EDITOR_FONT;
      const ligatures = configStore.get<boolean>("editor.fontLigatures");
      return EditorView.theme({
        ".cm-content": {
          fontFamily: stack,
          fontVariantLigatures: ligatures ? "normal" : "none",
          fontFeatureSettings: ligatures ? "normal" : '"liga" 0, "calt" 0',
        },
      });
    },
  },
  {
    id: "rainbow-brackets",
    compartment: new Compartment(),
    configKeys: ["editor.rainbowBrackets", "editor.rainbowBrackets.opacity", "_editorTheme"],
    build() {
      if (!configStore.get<boolean>("editor.rainbowBrackets")) return [];
      const colors = editorThemeKind() === "dark" ? DARK_COLORS : LIGHT_COLORS;
      const opacity = configStore.get<number>("editor.rainbowBrackets.opacity");
      return Prec.highest(makeRainbowBrackets(colors, opacity));
    },
  },
  {
    id: "indent-guides",
    compartment: new Compartment(),
    configKeys: ["editor.indentGuides.enabled", "editor.indentGuides.style", "editor.indentGuides.opacity"],
    build() {
      return configStore.get<boolean>("editor.indentGuides.enabled")
        ? makeIndentGuides(
            configStore.get<IndentGuideStyle>("editor.indentGuides.style"),
            configStore.get<number>("editor.indentGuides.opacity"),
          )
        : [];
    },
  },
];

// ── ADR-0024 Model B — extension-provided decorations ────────────────────────

/** Effect dispatched to a view to update (or clear) one extension provider's decoration set. */
export const setExtDecorations = StateEffect.define<{ providerId: string; decos: DecorationSet }>();

const _extDecorationsField = StateField.define<Map<string, DecorationSet>>({
  create: () => new Map(),
  update(prev, tr) {
    if (!tr.effects.some((e) => e.is(setExtDecorations))) return prev;
    const next = new Map(prev);
    for (const effect of tr.effects) {
      if (effect.is(setExtDecorations)) {
        next.set(effect.value.providerId, effect.value.decos);
      }
    }
    return next;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (map) => {
      const sets = [...map.values()];
      if (sets.length === 0) return Decoration.none;
      if (sets.length === 1) return sets[0];
      return RangeSet.join(sets);
    }),
});

/**
 * Dispatch updated decorations for one extension provider to all given views.
 * Pass `Decoration.none` to clear a provider's decorations.
 */
export function updateExtDecorations(views: EditorView[], providerId: string, decos: DecorationSet): void {
  for (const view of views) {
    view.dispatch({ effects: [setExtDecorations.of({ providerId, decos })] });
  }
}

/**
 * Returns seeded compartment extensions for use in buildEditorState.
 * Each compartment is pre-filled with the current config value.
 */
export function buildDecorationCompartmentExts(): Extension[] {
  // Diagnostic: log what each feature resolves to on EditorState creation.
  const exts = DECORATION_FEATURES.map((f) => {
    const ext = f.build();
    console.log(`[decoration-registry] ${f.id} build → enabled=${Array.isArray(ext) && ext.length === 0 ? false : true}`);
    return f.compartment.of(ext);
  });
  return [...exts, _extDecorationsField];
}

/**
 * Reconfigures compartments for any feature whose configKeys intersect changedKeys.
 * Called by features.ts on configStore.onDidChange.
 */
export function applyChangedDecorations(changedKeys: string[], views: EditorView[]): void {
  if (views.length === 0) return;
  const effects: ReturnType<typeof Compartment.prototype.reconfigure>[] = [];
  for (const feature of DECORATION_FEATURES) {
    if (feature.configKeys.some((k) => changedKeys.includes(k))) {
      effects.push(feature.compartment.reconfigure(feature.build()));
    }
  }
  if (effects.length === 0) return;
  for (const view of views) {
    view.dispatch({ effects });
  }
}
