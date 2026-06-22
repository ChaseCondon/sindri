import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { ThemeDef } from "../theme/tokens";

// Builds a CM6 Extension from a ThemeDef.
// Called by registry.ts when applying a theme; result stored in compartment.ts.
// The editor surface is self-contained — it reads only from ThemeDef.editor/syntax,
// never from root CSS vars, so the UI and editor themes can diverge (ADR-0019 §3).
export function buildCM6Extension(def: ThemeDef): Extension {
  const e = def.editor;
  const s = def.syntax;
  const se = def.syntaxExtended;

  const editorTheme = EditorView.theme(
    {
      "&": {
        color: e.fg,
        backgroundColor: e.bg,
        height: "100%",
        fontSize: "13.5px",
      },
      ".cm-content": {
        caretColor: e.caret,
        // font-family + ligatures are owned by the editor-font decoration feature
        // (decoration-registry.ts) so they react to settings without a theme rebuild.
        padding: "8px 0",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: e.caret },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: e.selection,
      },
      ".cm-activeLine": { backgroundColor: e.activeLine },
      ".cm-gutters": {
        backgroundColor: e["gutter.bg"],
        color: e["gutter.fg"],
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: e.activeLine,
        color: e["gutter.activeFg"],
      },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: e.matchingBracket,
        outline: `1px solid ${e.matchingBracket}`,
      },
      // Rainbow brackets — 6-level depth cycle (Atom One palette)
      ...(def.kind === "dark"
        ? {
            ".cm-rb-0": { color: "#e06c75" },
            ".cm-rb-1": { color: "#e5c07b" },
            ".cm-rb-2": { color: "#98c379" },
            ".cm-rb-3": { color: "#56b6c2" },
            ".cm-rb-4": { color: "#61afef" },
            ".cm-rb-5": { color: "#c678dd" },
          }
        : {
            ".cm-rb-0": { color: "#e45649" },
            ".cm-rb-1": { color: "#c18401" },
            ".cm-rb-2": { color: "#50a14f" },
            ".cm-rb-3": { color: "#0184bc" },
            ".cm-rb-4": { color: "#4078f2" },
            ".cm-rb-5": { color: "#a626a4" },
          }),
      // Indent guides — small dots via background-image using currentColor.
      // Rainbow mode sets class cm-rb-N alongside this to get depth-matched color.
      // Monochrome mode sets class cm-indent-guide-mono which provides the color.
      ".cm-indent-guide": {
        backgroundImage: "linear-gradient(to bottom, currentColor 0%, currentColor 25%, transparent 25%)",
        backgroundSize: "1.5px 6px",
        backgroundRepeat: "repeat-y",
        backgroundPosition: "0 2px",
      },
      ".cm-indent-guide-mono": {
        color: def.kind === "dark" ? "rgba(255,255,255,0.20)" : "rgba(0,0,0,0.22)",
      },
      // ── Tree-sitter token classes (ADR-0041 §6) ──────────────────────────
      ".cm-ts-keyword":    { color: s.keyword.color, ...(s.keyword.fontStyle ? { fontStyle: s.keyword.fontStyle } : {}) },
      ".cm-ts-function":   { color: s.function.color },
      ".cm-ts-string":     { color: s.string.color },
      ".cm-ts-comment":    { color: s.comment.color, fontStyle: s.comment.fontStyle ?? "italic" },
      ".cm-ts-type":       { color: s.type.color },
      ".cm-ts-variable":   { color: s.variable.color },
      ".cm-ts-number":     { color: s.number.color },
      ".cm-ts-constant":   { color: (se?.constant ?? s.number).color },
      ".cm-ts-operator":   { color: s.operator.color },
      ".cm-ts-property":   { color: s.property.color },
      ".cm-ts-punctuation":{ color: s.punctuation.color },
      ".cm-ts-tag":        { color: s.tag.color },
      ".cm-ts-attribute":  { color: s.attribute.color },
      ".cm-ts-namespace":  { color: (se?.namespace ?? s.type).color },
      ".cm-ts-constructor":{ color: s.function.color },
      ".cm-ts-module":     { color: (se?.namespace ?? s.type).color },
      ".cm-ts-label":      { color: s.variable.color },
      ".cm-ts-embedded":   { color: s.string.color },
    },
    { dark: def.kind === "dark" },
  );

  const highlightStyle = HighlightStyle.define([
    { tag: t.keyword, color: s.keyword.color, fontStyle: s.keyword.fontStyle },
    { tag: [t.controlKeyword, t.moduleKeyword], color: s.controlKeyword.color },
    { tag: [t.string, t.special(t.string)], color: s.string.color },
    { tag: [t.number, t.bool, t.null], color: s.number.color },
    {
      tag: [t.comment, t.lineComment, t.blockComment],
      color: s.comment.color,
      fontStyle: s.comment.fontStyle ?? "italic",
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName)],
      color: s.function.color,
    },
    { tag: [t.typeName, t.className], color: s.type.color },
    { tag: t.variableName, color: s.variable.color },
    { tag: t.propertyName, color: s.property.color },
    { tag: t.operator, color: s.operator.color },
    { tag: t.punctuation, color: s.punctuation.color },
    { tag: t.tagName, color: s.tag.color },
    { tag: t.attributeName, color: s.attribute.color },
    { tag: t.heading, color: s.heading.color, fontWeight: "bold" },
    { tag: [t.url, t.link], color: s.link.color },
    { tag: t.regexp, color: s.regexp.color },
    { tag: t.escape, color: s.escape.color },
  ]);

  return [editorTheme, syntaxHighlighting(highlightStyle)];
}
