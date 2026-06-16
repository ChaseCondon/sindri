// editor-state-bridge.ts — ADR-0034: webview-side half of sindri.editor.
//
// Responsibilities:
//   1. Watch active editor changes (SolidJS reactivity on groupStore) and push
//      "__sindri.editor.activeEditorChanged" events to the extension JS host.
//   2. Register a CM6 update listener (via registerEditorUpdateListener) to push
//      selection / doc-change / viewport events.
//   3. Push "__sindri.editor.documentOpened" / "…Closed" on buffer lifecycle.
//   4. Listen for "__sindri.editor.readReq" Tauri events and respond with
//      CM6 text reads (getText, lineAt, positionAt, offsetAt) via
//      ext_editor_read_result.
//   5. (Slice 2) Listen for decoration provider registration events, drive
//      provideDecorations IPC on viewport/doc changes, and update CM6 views.
//
// Import this module at app startup (App.tsx) to activate all subscriptions.
// It must be imported AFTER the extension host client is initialised.
import { createRoot, createEffect, untrack } from "solid-js";
import {
  groupStore,
  getActiveEditorView,
} from "./groups";
import {
  registry,
  savedTexts,
  docVersions,
  languageIdFor,
  registerEditorUpdateListener,
  onBufferCreated,
  onBufferRemoved,
} from "./buffers";
import { dispatch, listenExtEvent, deliverEditorReadResult, provideExtDecorations } from "../extensions/host";
import { isTauri } from "../lib/tauri";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { updateExtDecorations } from "./decoration-registry";

// ── Shared payload types ───────────────────────────────────────────────────────

interface EditorInfo {
  path: string | null;
  name: string;
  languageId: string;
  version: number;
  lineCount: number;
  selections: Array<{ from: number; to: number }>;
  visibleRanges: Array<{ from: number; to: number }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildEditorInfo(bufferId: string): EditorInfo | null {
  const buf = registry.buffers[bufferId];
  if (!buf) return null;

  const view = getActiveEditorView();
  const version = docVersions.get(bufferId) ?? 0;
  const contents = savedTexts.get(bufferId) ?? "";
  const lineCount = view
    ? view.state.doc.lines
    : contents.split("\n").length;

  const selections = view
    ? view.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }))
    : [];
  const visibleRanges = view
    ? view.visibleRanges.map((r) => ({ from: r.from, to: r.to }))
    : [];

  return {
    path: buf.path,
    name: buf.name,
    languageId: languageIdFor(buf.name),
    version,
    lineCount,
    selections,
    visibleRanges,
  };
}

function fireAndForget(promise: Promise<void>): void {
  promise.catch(() => {});
}

// ── 1. Active editor change tracking ─────────────────────────────────────────

createRoot(() => {
  createEffect(() => {
    const activeGroup = groupStore.activeGroup;
    const group = groupStore.groups[activeGroup];
    const bufferId = group?.activeBufferId ?? "";

    if (!bufferId) {
      fireAndForget(dispatch("__sindri.editor.activeEditorChanged", "null"));
      return;
    }

    // untrack so we only react to group/buffer changes, not the EditorView internals.
    const info = untrack(() => buildEditorInfo(bufferId));
    fireAndForget(
      dispatch("__sindri.editor.activeEditorChanged", info ? JSON.stringify(info) : "null"),
    );
  });
});

// ── 2. CM6 update listener — selection / doc / viewport events ────────────────

registerEditorUpdateListener((update, bufferId) => {
  const group = groupStore.groups[groupStore.activeGroup];
  if (group?.activeBufferId !== bufferId) return; // only active buffer

  const buf = registry.buffers[bufferId];
  if (!buf) return;

  const version = docVersions.get(bufferId) ?? 0;

  if (update.selectionSet) {
    const selections = update.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
    fireAndForget(
      dispatch(
        "__sindri.editor.selectionChanged",
        JSON.stringify({
          path: buf.path,
          name: buf.name,
          languageId: languageIdFor(buf.name),
          version,
          lineCount: update.state.doc.lines,
          selections,
          visibleRanges: update.view.visibleRanges.map((r) => ({ from: r.from, to: r.to })),
        }),
      ),
    );
  }

  if (update.docChanged) {
    // docVersions is already incremented by buffers.ts updateListener before this runs.
    const newVersion = docVersions.get(bufferId) ?? version;
    fireAndForget(
      dispatch(
        "__sindri.editor.documentChanged",
        JSON.stringify({
          path: buf.path,
          name: buf.name,
          languageId: languageIdFor(buf.name),
          version: newVersion,
          lineCount: update.state.doc.lines,
        }),
      ),
    );
  }

  if (update.viewportChanged) {
    fireAndForget(
      dispatch(
        "__sindri.editor.viewportChanged",
        JSON.stringify({
          path: buf.path,
          name: buf.name,
          languageId: languageIdFor(buf.name),
          version,
          lineCount: update.state.doc.lines,
          visibleRanges: update.view.visibleRanges.map((r) => ({ from: r.from, to: r.to })),
        }),
      ),
    );
  }

  // Slice 2: re-request decorations when viewport or document changes.
  if ((update.docChanged || update.viewportChanged) && _registeredDecorationProviders.size > 0) {
    for (const [pid, { extId }] of _registeredDecorationProviders) {
      _scheduleDecorationProvide(pid, extId);
    }
  }
});

// ── 3. Buffer lifecycle — open / close document events ────────────────────────

onBufferCreated((id, path, name) => {
  const version = docVersions.get(id) ?? 0;
  const contents = savedTexts.get(id) ?? "";
  fireAndForget(
    dispatch(
      "__sindri.editor.documentOpened",
      JSON.stringify({
        path,
        name,
        languageId: languageIdFor(name),
        version,
        lineCount: contents.split("\n").length,
      }),
    ),
  );
});

onBufferRemoved((id, path, name) => {
  const version = docVersions.get(id) ?? 0;
  fireAndForget(
    dispatch(
      "__sindri.editor.documentClosed",
      JSON.stringify({
        path,
        name,
        languageId: languageIdFor(name),
        version,
        lineCount: 0,
      }),
    ),
  );
});

// ── 4. Proxy read requests (getText, lineAt, positionAt, offsetAt) ─────────────
// The extension JS host emits "__sindri.editor.readReq" via the Tauri event bus;
// we respond with the result via ext_editor_read_result.

if (isTauri()) {
  listenExtEvent("__sindri.editor.readReq", (payloadStr) => {
    let requestId = "";
    try {
      const { requestId: rid, req } = JSON.parse(payloadStr) as {
        requestId: string;
        req: { op: string; range?: { from: number; to: number } | null; line?: number; offset?: number; position?: { line: number; character: number } };
      };
      requestId = rid;
      const view = getActiveEditorView();

      if (!view) {
        fireAndForget(deliverEditorReadResult(requestId, "null"));
        return;
      }

      const doc = view.state.doc;
      let result: string;

      if (req.op === "getText") {
        const text = req.range
          ? doc.sliceString(req.range.from, req.range.to)
          : doc.toString();
        result = JSON.stringify(text);
      } else if (req.op === "lineAt") {
        const lineNum = req.line ?? 1;
        const line = doc.line(Math.max(1, Math.min(lineNum, doc.lines)));
        result = JSON.stringify({ from: line.from, to: line.to, text: line.text });
      } else if (req.op === "positionAt") {
        const offset = Math.max(0, Math.min(req.offset ?? 0, doc.length));
        const line = doc.lineAt(offset);
        result = JSON.stringify({ line: line.number, character: offset - line.from });
      } else if (req.op === "offsetAt") {
        const pos = req.position ?? { line: 1, character: 0 };
        const lineNum = Math.max(1, Math.min(pos.line, doc.lines));
        const line = doc.line(lineNum);
        const offset = Math.min(line.from + pos.character, line.to);
        result = JSON.stringify(offset);
      } else {
        result = "null";
      }

      fireAndForget(deliverEditorReadResult(requestId, result));
    } catch {
      if (requestId) fireAndForget(deliverEditorReadResult(requestId, "null"));
    }
  }).catch(() => {});
}

// ── 5. Decoration provider bridge (ADR-0034 Slice 2) ─────────────────────────
// Registered providers: id → { extId, configKeys, css }
const _registeredDecorationProviders = new Map<string, { extId: string; configKeys: string[]; css: string }>();
const _decoDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

type DecorationDatum =
  | { kind: "mark"; from: number; to: number; class: string; cssVars?: Record<string, string> }
  | { kind: "line"; line: number; class: string; cssVars?: Record<string, string> };

function _buildDecorationSet(datums: DecorationDatum[], doc: { lines: number; line(n: number): { from: number; to: number } }): DecorationSet {
  if (datums.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder<ReturnType<typeof Decoration.mark>>();

  // RangeSetBuilder requires additions in ascending order.
  const sorted = [...datums].sort((a, b) => {
    const af = a.kind === "mark" ? a.from : doc.line(Math.max(1, Math.min(a.line, doc.lines))).from;
    const bf = b.kind === "mark" ? b.from : doc.line(Math.max(1, Math.min(b.line, doc.lines))).from;
    return af !== bf ? af - bf : 0;
  });

  for (const datum of sorted) {
    const style = datum.cssVars
      ? Object.entries(datum.cssVars).map(([k, v]) => `${k}:${v}`).join(";")
      : undefined;
    const attrs = style ? { style } : undefined;

    if (datum.kind === "mark") {
      if (datum.from < datum.to) {
        builder.add(datum.from, datum.to, Decoration.mark({ class: datum.class, attributes: attrs }));
      }
    } else if (datum.kind === "line") {
      const lineNum = Math.max(1, Math.min(datum.line, doc.lines));
      const lineFrom = doc.line(lineNum).from;
      builder.add(lineFrom, lineFrom, Decoration.line({ class: datum.class, attributes: attrs }));
    }
  }

  return builder.finish();
}

function _getActiveBufferId(): string {
  const group = groupStore.groups[groupStore.activeGroup];
  return group?.activeBufferId ?? "";
}

async function _doProvide(providerId: string, extId: string): Promise<void> {
  const view = getActiveEditorView();
  if (!view) {
    console.warn(`[bridge] _doProvide(${providerId}): no active editor view`);
    return;
  }

  const bufferId = _getActiveBufferId();
  const buf = registry.buffers[bufferId];
  if (!buf) {
    console.warn(`[bridge] _doProvide(${providerId}): no active buffer (id="${bufferId}")`);
    return;
  }

  const { from, to } = view.viewport;
  const doc = view.state.doc;
  const text = doc.sliceString(from, to);
  const firstLine = doc.lineAt(from).number;
  const version = docVersions.get(bufferId) ?? 0;
  const languageId = languageIdFor(buf.name);

  const ctx = { text, from, to, firstLine, languageId, version };
  console.log(`[bridge] _doProvide(${providerId}): extId="${extId}" viewport=${from}-${to}`);

  try {
    const resultJson = await provideExtDecorations(extId, providerId, JSON.stringify(ctx));
    const datums = JSON.parse(resultJson) as DecorationDatum[];
    console.log(`[bridge] _doProvide(${providerId}): got ${datums.length} datum(s)`);

    // Re-check view is still valid after async round-trip.
    const currentView = getActiveEditorView();
    if (!currentView) return;

    const decos = _buildDecorationSet(datums, currentView.state.doc);
    updateExtDecorations([currentView], providerId, decos);
  } catch (e) {
    console.error(`[bridge] _doProvide(${providerId}) error:`, e);
  }
}

function _scheduleDecorationProvide(providerId: string, extId: string): void {
  const prev = _decoDebounceTimers.get(providerId);
  if (prev != null) clearTimeout(prev);
  _decoDebounceTimers.set(
    providerId,
    setTimeout(() => {
      _decoDebounceTimers.delete(providerId);
      _doProvide(providerId, extId).catch(() => {});
    }, 50),
  );
}

// React to active editor changes so decorations appear when switching buffers.
createRoot(() => {
  createEffect(() => {
    const bufferId = _getActiveBufferId();
    if (bufferId && _registeredDecorationProviders.size > 0) {
      for (const [pid, { extId }] of _registeredDecorationProviders) {
        _scheduleDecorationProvide(pid, extId);
      }
    }
  });
});

if (isTauri()) {
  listenExtEvent("__sindri.editor.decorationProviderRegistered", (payloadStr) => {
    const data = JSON.parse(payloadStr) as { id: string; extId: string; configKeys: string[]; css: string };
    const extId = data.extId ?? "unknown";
    _registeredDecorationProviders.set(data.id, { extId, configKeys: data.configKeys, css: data.css });

    // Inject (or update) provider CSS into the host page so its classes take effect.
    if (data.css) {
      const styleId = `sindri-ext-decor-${data.id}`;
      const existing = document.getElementById(styleId);
      if (existing) {
        existing.textContent = data.css;
      } else {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = data.css;
        document.head.appendChild(style);
      }
    }

    // Only kick off an immediate provide if an editor is already open.
    // If not, the createEffect below will trigger it when the user opens a file.
    if (getActiveEditorView()) {
      _scheduleDecorationProvide(data.id, extId);
    }
  }).catch(() => {});

  listenExtEvent("__sindri.editor.decorationProviderDisposed", (payloadStr) => {
    const id = payloadStr.trim().replace(/^"|"$/g, "");
    _removeDecorationProvider(id);
  }).catch(() => {});
}

function _removeDecorationProvider(providerId: string): void {
  _registeredDecorationProviders.delete(providerId);
  const timer = _decoDebounceTimers.get(providerId);
  if (timer != null) { clearTimeout(timer); _decoDebounceTimers.delete(providerId); }
  document.getElementById(`sindri-ext-decor-${providerId}`)?.remove();
  const view = getActiveEditorView();
  if (view) updateExtDecorations([view], providerId, Decoration.none);
}

/**
 * Re-broadcast the current active editor state to all extensions.
 *
 * The `createEffect` above fires once at startup — before extensions activate
 * and register their `onDidChangeActiveEditor` handlers. Calling this after
 * all extensions have activated ensures they receive the initial editor state
 * without needing the user to switch tabs.
 */
export function rebroadcastActiveEditor(): void {
  const activeGroup = groupStore.activeGroup;
  const group = groupStore.groups[activeGroup];
  const bufferId = group?.activeBufferId ?? "";
  if (!bufferId) return;
  const info = buildEditorInfo(bufferId);
  if (info) {
    fireAndForget(dispatch("__sindri.editor.activeEditorChanged", JSON.stringify(info)));
  }
}

/** Remove all decoration providers registered by an extension and clear their decorations immediately. */
export function deregisterExtDecorations(extId: string): void {
  const providers: string[] = [];
  for (const [pid, { extId: eid }] of _registeredDecorationProviders) {
    if (eid === extId) providers.push(pid);
  }
  for (const pid of providers) _removeDecorationProvider(pid);
}
