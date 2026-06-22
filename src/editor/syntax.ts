// Tree-sitter CM6 decoration bridge — ADR-0041 §7.
//
// Stale-then-reconcile: existing decorations persist immediately on any change;
// the IPC round-trip to the Rust syntax worker is debounced and its result
// reconciles the decoration set asynchronously (ADR-0003 hard rule).
import { invoke } from "@tauri-apps/api/core";
import {
  StateEffect,
  StateField,
  RangeSetBuilder,
  type ChangeSet,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { isTauri } from "../lib/tauri";

// ── Wire types (matching Rust serde camelCase output) ─────────────────────────

interface Highlight {
  start: number;
  end: number;
  token: string;
}

interface InputEditDelta {
  startByte: number;
  oldEndByte: number;
  newEndByte: number;
  startRow: number;
  startCol: number;
  oldEndRow: number;
  oldEndCol: number;
  newEndRow: number;
  newEndCol: number;
  replacement: string;
}

// ── UTF-8 byte ↔ CM6 char position conversion ─────────────────────────────────
//
// CM6 positions are UTF-16 code units; tree-sitter uses UTF-8 byte offsets.
// For all-ASCII source code (the common case) these are identical.
// For code with multibyte characters (CJK, emoji) we must walk the text.

const _enc = new TextEncoder();

export function posToByteOffset(doc: Text, charPos: number): number {
  let bytes = 0;
  let chars = 0;
  const iter = doc.iter();
  outer: while (!iter.done) {
    for (const cp of iter.value) {
      if (chars >= charPos) break outer;
      const code = cp.codePointAt(0)!;
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code <= 0xffff) bytes += 3;
      else bytes += 4;
      chars += code > 0xffff ? 2 : 1; // surrogate pairs are 2 CM6 units
    }
    iter.next();
  }
  return bytes;
}

export function byteOffsetToPos(doc: Text, byteOffset: number): number {
  let bytes = 0;
  let chars = 0;
  const iter = doc.iter();
  outer: while (!iter.done) {
    for (const cp of iter.value) {
      if (bytes >= byteOffset) break outer;
      const code = cp.codePointAt(0)!;
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code <= 0xffff) bytes += 3;
      else bytes += 4;
      chars += code > 0xffff ? 2 : 1;
    }
    iter.next();
  }
  return chars;
}

// Byte column within the line (tree-sitter Point.column = byte offset from line start).
export function byteCol(doc: Text, lineFrom: number, charPos: number): number {
  return _enc.encode(doc.sliceString(lineFrom, charPos)).length;
}

// ── StateEffect + StateField ──────────────────────────────────────────────────

const setHighlightDecos = StateEffect.define<DecorationSet>();

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    // Map existing decorations through any document changes to stay anchored.
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHighlightDecos)) decos = e.value;
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── Build DecorationSet from Highlight[] ──────────────────────────────────────

function buildDecoSet(doc: Text, highlights: Highlight[]): DecorationSet {
  if (highlights.length === 0) return Decoration.none;

  const spans: { from: number; to: number; cls: string }[] = [];
  for (const h of highlights) {
    const from = byteOffsetToPos(doc, h.start);
    const to = byteOffsetToPos(doc, h.end);
    if (from < to && to <= doc.length) {
      spans.push({ from, to, cls: `cm-ts-${h.token}` });
    }
  }
  // RangeSetBuilder requires ascending from, then ascending to.
  spans.sort((a, b) => a.from !== b.from ? a.from - b.from : a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const s of spans) {
    builder.add(s.from, s.to, Decoration.mark({ class: s.cls }));
  }
  return builder.finish();
}

// ── ViewPlugin ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 50;

// Unique doc ID per view instance so two groups showing the same buffer
// each have independent parse state in the Rust worker.
let _docIdSeq = 0;

class SyntaxViewPlugin {
  private _debounce: ReturnType<typeof setTimeout> | null = null;
  private _open = false;
  private _opening = false;
  // The doc that was last sent to the Rust worker as a full open/reopen.
  private _lastSyncedDoc: Text;
  // Composed changeset from _lastSyncedDoc to the current doc, null = no pending edits.
  private _pendingChanges: ChangeSet | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly docId: string,
    private readonly languageId: string,
  ) {
    this._lastSyncedDoc = view.state.doc;
    this._doOpen();
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      // Compose incremental changes onto the accumulated pending set.
      // ChangeSet.compose() requires that each change maps from the previous
      // change's output doc — this holds because we accumulate sequentially.
      this._pendingChanges = this._pendingChanges
        ? this._pendingChanges.compose(update.changes)
        : update.changes;
    }
    if (update.docChanged || update.viewportChanged) {
      this._schedule();
    }
  }

  destroy() {
    if (this._debounce !== null) { clearTimeout(this._debounce); this._debounce = null; }
    if (this._open) {
      invoke("ts_close", { docId: this.docId }).catch(() => {});
      this._open = false;
    }
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────

  private _schedule() {
    if (this._debounce !== null) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      this._debounce = null;
      this._flush();
    }, DEBOUNCE_MS);
  }

  private _flush() {
    if (!this._open) {
      // Grammar may now be registered — retry ts_open with the current doc.
      this._doOpen();
      return;
    }
    if (this._pendingChanges !== null) {
      const changes = this._pendingChanges;
      const syncedDoc = this._lastSyncedDoc;
      this._pendingChanges = null;
      this._lastSyncedDoc = this.view.state.doc;
      this._doEdit(changes, syncedDoc);
    } else {
      this._doHighlight();
    }
  }

  // ── IPC calls ───────────────────────────────────────────────────────────────

  private _doOpen() {
    if (this._opening) return;
    this._opening = true;

    // Snapshot synchronously so changes arriving during the async round-trip
    // are correctly accumulated against this doc in _pendingChanges.
    const sentDoc = this.view.state.doc;
    this._lastSyncedDoc = sentDoc;
    this._pendingChanges = null;

    const { from, to } = this.view.viewport;
    invoke<Highlight[]>("ts_open", {
      docId: this.docId,
      languageId: this.languageId,
      text: sentDoc.toString(),
      viewportStart: posToByteOffset(sentDoc, from),
      viewportEnd: posToByteOffset(sentDoc, to),
    }).then((highlights) => {
      this._open = true;
      // Any changes that arrived while awaiting are in _pendingChanges; flush them.
      if (this._pendingChanges !== null) this._schedule();
      this._reconcile(highlights);
    }).catch(() => {
      // Grammar not registered yet (item 3). Will retry on next update.
    }).finally(() => {
      this._opening = false;
    });
  }

  private _doEdit(changes: ChangeSet, syncedDoc: Text) {
    const edits: InputEditDelta[] = [];

    // iterChanges gives positions in syncedDoc's coordinate space, which is
    // what the Rust worker expects: all offsets relative to the pre-batch doc.
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const startByte = posToByteOffset(syncedDoc, fromA);
      const oldEndByte = posToByteOffset(syncedDoc, toA);
      const insertedStr = inserted.toString();
      const insertedBytes = _enc.encode(insertedStr).length;
      const newEndByte = startByte + insertedBytes;

      const startLine = syncedDoc.lineAt(fromA);
      const oldEndLine = syncedDoc.lineAt(toA);
      const startColBytes = byteCol(syncedDoc, startLine.from, fromA);

      // Derive new_end_row / new_end_col from the inserted text content.
      const insertedLines = insertedStr.split("\n");
      const newEndRow = (startLine.number - 1) + insertedLines.length - 1;
      const lastInserted = insertedLines[insertedLines.length - 1];
      const newEndCol = insertedLines.length === 1
        ? startColBytes + _enc.encode(lastInserted).length
        : _enc.encode(lastInserted).length;

      edits.push({
        startByte,
        oldEndByte,
        newEndByte,
        startRow: startLine.number - 1,
        startCol: startColBytes,
        oldEndRow: oldEndLine.number - 1,
        oldEndCol: byteCol(syncedDoc, oldEndLine.from, toA),
        newEndRow,
        newEndCol,
        replacement: insertedStr,
      });
    });

    const { from, to } = this.view.viewport;
    const currentDoc = this.view.state.doc;

    invoke<Highlight[]>("ts_edit", {
      docId: this.docId,
      edits,
      viewportStart: posToByteOffset(currentDoc, from),
      viewportEnd: posToByteOffset(currentDoc, to),
    }).then((h) => {
      if (this.view.dom.isConnected) this._reconcile(h);
    }).catch(() => {});
  }

  private _doHighlight() {
    const { from, to } = this.view.viewport;
    const doc = this.view.state.doc;

    invoke<Highlight[]>("ts_highlight", {
      docId: this.docId,
      viewportStart: posToByteOffset(doc, from),
      viewportEnd: posToByteOffset(doc, to),
    }).then((h) => {
      if (this.view.dom.isConnected) this._reconcile(h);
    }).catch(() => {});
  }

  private _reconcile(highlights: Highlight[]) {
    if (!this.view.dom.isConnected) return;
    const decos = buildDecoSet(this.view.state.doc, highlights);
    this.view.dispatch({ effects: setHighlightDecos.of(decos) });
  }
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Returns CM6 extensions for the tree-sitter highlight bridge (ADR-0041 §7).
 * Each call gets a unique doc ID so two groups viewing the same buffer have
 * independent parse state in the Rust worker without collision.
 * Returns [] in browser mode (no Tauri IPC available).
 */
export function treeSitterHighlighting(bufferId: string, languageId: string): Extension {
  if (!isTauri()) return [];
  const docId = `${bufferId}:${++_docIdSeq}`;
  return [
    highlightField,
    ViewPlugin.define((view) => new SyntaxViewPlugin(view, docId, languageId)),
  ];
}
