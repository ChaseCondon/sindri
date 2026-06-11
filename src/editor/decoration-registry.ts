// Editor decoration registry — ADR-0024 Model A (static bundled features)
// Owns one Compartment per feature; builds Extensions from configStore values.
// No import from groups.ts — maintains the buffers→registry cycle-free invariant.
// applyChangedDecorations() is called from features.ts (which owns the views lookup).
import { Compartment, Prec, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
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

const DECORATION_FEATURES: DecorationFeature[] = [
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
  return exts;
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
