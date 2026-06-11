import { ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
export type IndentGuideStyle = "monochrome" | "rainbow";

function getLeadingWs(text: string): number {
  let i = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return i;
}

function buildDecorations(view: EditorView, style: IndentGuideStyle, opacity: number): DecorationSet {
  const ranges: Range<ReturnType<typeof Decoration.mark>>[] = [];
  const state = view.state;
  const unitStr: string = state.facet(indentUnit);
  const indentSize = unitStr.includes("\t") ? 1 : (unitStr.length || 4);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      const lineText = line.text;
      const contentStart = getLeadingWs(lineText);

      if (contentStart > 0 && contentStart < lineText.length) {
        if (lineText[0] === "\t") {
          // Tab-indented: one guide per tab character, depth = tab index
          for (let i = 0; i < contentStart; i++) {
            ranges.push(
              Decoration.mark({ class: guideClass(style, i), attributes: { style: `opacity:${opacity}` } }).range(
                line.from + i,
                line.from + i + 1,
              ),
            );
          }
        } else {
          // Space-indented: guide at each indent-unit boundary, depth = stop / indentSize
          let stop = 0;
          let depth = 0;
          while (stop < contentStart) {
            ranges.push(
              Decoration.mark({ class: guideClass(style, depth), attributes: { style: `opacity:${opacity}` } }).range(
                line.from + stop,
                line.from + stop + 1,
              ),
            );
            stop += indentSize;
            depth++;
          }
        }
      }

      pos = line.to + 1;
    }
  }

  return Decoration.set(ranges, true);
}

function guideClass(style: IndentGuideStyle, depth: number): string {
  if (style === "rainbow") return `cm-indent-guide cm-rb-${depth % 6}`;
  return "cm-indent-guide cm-indent-guide-mono";
}

export function makeIndentGuides(style: IndentGuideStyle, opacity: number = 1) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, style, opacity);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, style, opacity);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
