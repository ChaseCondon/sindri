# ADR-0034: `sindri.editor` namespace — the document/text surface every editor-touching extension uses

- **Status:** Accepted
- **Date:** 2026-06-12
- **Closes deferral in:** [ADR-0015](0015-js-extension-host-runtime.md) §4 (`sindri.editor` was sketched as "document model proxy · selections · decorations · onDidApplyEdit" but never built)
- **Hosts:** [ADR-0024](0024-editor-decorations-api.md) (decorations — the first capability landing in this namespace, Model B / roadmap 1.5g)
- **Constrained by:** [ADR-0025](0025-js-extension-host-deno-v8.md) (no DOM in host; document lives in the webview), [ADR-0003](0003-editor-surface-cm6-plus-webgl2.md) (CM6 surface), [ADR-0016](0016-editor-buffer-and-tab-model.md) (per-tab `EditorState`)

## Context

`sindri.editor` was listed in ADR-0015 §4 as a namespace — *document model proxy · selections · decorations · onDidApplyEdit · onDidChangeSelection · onDidOpenDocument* — but **no part of it was ever implemented** (the host has zero `sindri.editor` today). ADR-0024 then specced the *decoration* mechanics and referenced those primitives as "(existing)" — they were not.

Implementing decorations (1.5g) forces the question the project kept deferring: **what is the whole `sindri.editor` surface, so decorations are a citizen of a coherent namespace rather than a bespoke one-off** — the way `sindri.ui` (ADR-0026) is one designed surface (status bar · tree · quick-pick · webview), not a method bag. This ADR defines that surface and pins the v1 implementation scope.

### The editor-touching API is a *family*, not one namespace

"Everything that touches the editor" is deliberately split across several namespaces and ADRs. `sindri.editor` is **only the document/text surface**. Mapping the whole family is part of being "fully fleshed" — it tells an author exactly where each capability lives:

| Capability | Namespace | ADR | Status |
| --- | --- | --- | --- |
| Document read (text, lines, selections, visible ranges) + change events | `sindri.editor` | **0034 (this)** | v1 (1.5g) |
| Range decorations — CSS class (+`cssVars`) on marks/lines | `sindri.editor` | [0024](0024-editor-decorations-api.md) | v1 (1.5g) |
| Document **writes** — edits, set-selection, reveal (gated `editor.mutate`) | `sindri.editor` | 0034 (this) | **Deferred** — undo/redo + concurrent-edit semantics |
| Inline-text annotations (git blame), gutter widgets, minimap, viewport chrome | `sindri.ui` (surface C) | [0029](0029-editor-overlay-api.md) | Reserved |
| Custom editors (binary/visual editors over a doc) | `sindri.ui` (surface B) | [0028](0028-custom-editor-api.md) | Reserved |
| Completion · hover · diagnostics (raw provider API) | `sindri.languages` | 0015 §4 | Deferred |
| Language servers | `sindri.lsp` | 0015 §4 | Deferred |

> The dividing line for decorations vs overlays: **"a CSS class on a document range" → `sindri.editor` (0024). "a thing that isn't in the text" (blame text, gutter widget, minimap) → surface C (0029).**

## Decision

### 1. The namespace surface (full intended shape)

```ts
interface Range { from: number; to: number; }          // absolute doc offsets — the lingua franca
interface Position { line: number; character: number; } // 1-based line (CM6 convention), 0-based char

interface TextDocument {            // live proxy: reads cross IPC to the webview ⇒ async (cf. sindri.env.fs)
  readonly path: string;
  readonly languageId: string;
  readonly version: number;         // monotonic; bumps on every edit
  readonly lineCount: number;
  getText(range?: Range): Promise<string>;
  lineAt(line: number): Promise<{ from: number; to: number; text: string }>;
  positionAt(offset: number): Promise<Position>;
  offsetAt(position: Position): Promise<number>;
}

interface TextEditor {
  readonly document: TextDocument;
  readonly selections: Range[];      // last-known snapshot; live value via onDidChangeSelection
  readonly visibleRanges: Range[];
  // ── write surface, gated by editor.mutate — DEFERRED (§4) ──
  // edit(fn): Promise<boolean>; setSelections(r): void; revealRange(r): void;
}

interface SindriEditor {
  readonly activeEditor: TextEditor | undefined;
  readonly visibleEditors: TextEditor[];

  onDidChangeActiveEditor(fn: (e: TextEditor | undefined) => void): Disposable;
  onDidChangeSelection(fn: (e: { editor: TextEditor; selections: Range[] }) => void): Disposable;
  onDidChangeVisibleRanges(fn: (e: { editor: TextEditor; visibleRanges: Range[] }) => void): Disposable;
  onDidOpenDocument(fn: (d: TextDocument) => void): Disposable;
  onDidCloseDocument(fn: (d: TextDocument) => void): Disposable;
  onDidChangeDocument(fn: (e: { document: TextDocument }) => void): Disposable;

  registerDecorationProvider(id: string, provider: DecorationProvider): Disposable; // ADR-0024, gated editor.mutate
}
```

### 2. The architectural pivot: two access modes over one vocabulary

The document lives in the **webview** (CM6), not the host (ADR-0025: no DOM in host). So a live read must cross IPC. That collides with ADR-0024's mandate that decoration `provide()` be a **pure, synchronous, fast** function. They reconcile by offering **two access modes over the same `TextDocument` vocabulary** — never a second vocabulary:

| Mode | Shape | For |
| --- | --- | --- |
| **Async live proxy** | `await activeEditor.document.getText(range)` | any provider reading arbitrary/out-of-viewport doc state, reacting to selection, etc. |
| **Sync pushed snapshot** | `ctx.document.getText()` inside `provide(ctx)` — no `await` | decoration providers (ADR-0024), which must not block on IPC mid-paint |

`DecorationContext.document` is therefore a `DocumentSnapshot` — a **sync, in-callback projection** of `TextDocument` (same field names: `languageId`, `version`; plus the snapshotted `from`/`to`/`firstLine` slice and a sync `getText()`). One vocabulary, two delivery mechanisms matched to their constraints.

### 3. The wire (Surface A) reuses the established request/response + event-bus patterns

| Concern | Mechanism | Mirrors |
| --- | --- | --- |
| Read proxy call (`getText`, `lineAt`, …) | `ext_editor_<op>(…) → JSON` request/response | `ext_tree_view_get_children` |
| Decoration `provide` round trip | `ext_editor_provide_decorations(id, ctxJson) → DecorationDatum[] JSON` | `ext_tree_view_get_children` |
| Editor events (active/selection/visible/open/close/change) | core emits over the existing event channel; host fans out to `onDid*` subscribers | `ext-event` bus |

Editor **state lives in the webview**; the Rust host is a **pass-through broker**. The webview owns the source of truth (active editor, selections, viewport) and pushes change events to the host, which delivers them to subscribers and answers proxy reads by round-tripping to the webview.

### 4. v1 implementation scope (roadmap 1.5g)

**Ships now:** `registerDecorationProvider` (ADR-0024) **plus** the read/event primitives its sibling consumers need first — `activeEditor`, `visibleEditors`, the async `TextDocument` proxy (`path`/`languageId`/`version`/`lineCount`/`getText`/`lineAt`), and `onDidChangeActiveEditor` · `onDidChangeSelection` · `onDidChangeVisibleRanges` · `onDidOpenDocument` · `onDidCloseDocument` · `onDidChangeDocument`.

**Deferred (typed-but-throwing stubs, per the `@sindri/api` stub convention):** the **write surface** (`edit`/`setSelections`/`revealRange`) — it drags in undo/redo grouping and concurrent-edit/version-conflict semantics that are their own design problem. `positionAt`/`offsetAt` may also defer if not needed by the first consumers.

The whole namespace is gated by the `editor.mutate` permission **for writes and decorations**; pure reads (`getText`, events) require no permission (consistent with `sindri.env.fs.read` being ungated).

## Consequences

- **Decorations are a citizen, not an island.** `DecorationContext` is a projection of `TextDocument`, and the webview's decoration re-request rides the **public** `onDidChangeVisibleRanges`/`onDidChangeDocument` events — the spine is dogfood, not a private channel.
- **The family map is explicit.** An author knows blame-inline/gutter/minimap = ADR-0029, completion/hover = `sindri.languages`, custom editors = ADR-0028 — none of which this ADR redraws.
- **Async-read is the honest cost of not syncing the document to the host.** We deliberately do *not* replicate the buffer into the V8 isolate (memory + sync-protocol cost, ADR-0025); the price is that live reads are Promises. Decoration providers escape this via the pushed sync snapshot.
- **Coherent surface, incremental landing.** Like `sindri.ui`, the namespace is designed whole and implemented in slices; writes land when a concrete mutation consumer (e.g. a formatter/codemod extension) drives the undo design.

### Deferred

- **Write surface** — `edit`/`setSelections`/`revealRange`, undo grouping, version-conflict policy.
- **`onDidChangeDocument` granularity** — whether it carries a content-change delta or just signals "changed + new version" (v1: the latter).
- **Document sync option** — if async proxy reads prove too chatty, a future replicated-document protocol could make `TextDocument` sync; out of scope until measured.

## See also

- [ADR-0024](0024-editor-decorations-api.md) — decoration mechanics (Model A/B, `DecorationDatum`, `cssVars`) hosted in this namespace
- [ADR-0015](0015-js-extension-host-runtime.md) §4 — the namespace taxonomy + `editor.mutate` gate this fulfils
- [ADR-0025](0025-js-extension-host-deno-v8.md) — why the document stays in the webview (async proxy)
- [ADR-0029](0029-editor-overlay-api.md) / [ADR-0028](0028-custom-editor-api.md) — the surface-C/B seams this namespace defers to
