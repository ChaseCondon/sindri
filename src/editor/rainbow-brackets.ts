import { ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { EditorState, Range } from "@codemirror/state";

const NUM_COLORS = 6;
const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);

// Atom One palette — kept in sync with theme.ts cm-rb-N definitions.
export const DARK_COLORS  = ["#e06c75","#e5c07b","#98c379","#56b6c2","#61afef","#c678dd"];
export const LIGHT_COLORS = ["#e45649","#c18401","#50a14f","#0184bc","#4078f2","#a626a4"];

// Walk the syntax tree once to collect all string/comment/regex ranges.
// Checking these upfront (O(n log n)) is cheaper than resolveInner() per bracket.
function buildExcludedRanges(state: EditorState): { from: number; to: number }[] {
  const excluded: { from: number; to: number }[] = [];
  syntaxTree(state).cursor().iterate((node) => {
    const name = node.name.toLowerCase();
    if (
      name.includes("string") ||
      name.includes("comment") ||
      name.includes("template") ||
      name.includes("regexp") ||
      name.includes("regex")
    ) {
      excluded.push({ from: node.from, to: node.to });
      return false;
    }
  });
  return excluded;
}

function inExcluded(pos: number, excluded: { from: number; to: number }[]): boolean {
  let lo = 0;
  let hi = excluded.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (excluded[mid].to <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo < excluded.length && excluded[lo].from <= pos;
}

function buildDecorations(state: EditorState, colors: string[], opacity: number): DecorationSet {
  const excluded = buildExcludedRanges(state);
  const ranges: Range<typeof Decoration.mark.prototype>[] = [];
  const depthStack: number[] = [];
  const doc = state.doc;
  const opacityStr = opacity < 1 ? `;opacity:${opacity}` : "";

  // Scan the full document left-to-right for correct bracket depth at any position.
  const text = doc.toString();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (OPEN_BRACKETS.has(ch) && !inExcluded(i, excluded)) {
      const colorIdx = depthStack.length % NUM_COLORS;
      depthStack.push(colorIdx);
      ranges.push(
        Decoration.mark({ attributes: { style: `color:${colors[colorIdx]}${opacityStr}` } }).range(i, i + 1),
      );
    } else if (CLOSE_BRACKETS.has(ch) && !inExcluded(i, excluded)) {
      const colorIdx = depthStack.length > 0 ? depthStack.pop()! : 0;
      ranges.push(
        Decoration.mark({ attributes: { style: `color:${colors[colorIdx]}${opacityStr}` } }).range(i, i + 1),
      );
    }
  }

  return Decoration.set(ranges, true);
}

// Guard: skip rainbow coloring on very large documents to avoid jank.
const MAX_DOC_SIZE = 200_000;

/** Build a rainbow-brackets ViewPlugin that colors brackets by nesting depth.
 *  Pass DARK_COLORS or LIGHT_COLORS depending on the active editor theme. */
export function makeRainbowBrackets(colors: string[], opacity: number) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations =
          view.state.doc.length <= MAX_DOC_SIZE
            ? buildDecorations(view.state, colors, opacity)
            : Decoration.none;
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations =
            update.state.doc.length <= MAX_DOC_SIZE
              ? buildDecorations(update.state, colors, opacity)
              : Decoration.none;
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
