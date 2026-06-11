# ADR-0016: Editor buffer & tab model

- Status: Accepted
- Date: 2026-06-02

## Context

The walking skeleton edits **one file at a time**: `App.tsx` holds a single `file`
signal and a single global `dirty` flag, and `Editor.tsx` owns one CodeMirror 6
`EditorView` whose document is overwritten whenever a new file is opened
(`src/editor/Editor.tsx:64`). Clicking a second file in the explorer **destroys the
first file's edit state** (history, selection, scroll, unsaved changes).

Tabs are the gate to being a real IDE. Designing them forces three decisions that
are easy to get wrong and expensive to retrofit:

1. **How CM6 state is held per tab** — one view reused across tabs, or one view per tab.
2. **Where that state lives relative to SolidJS reactivity** — a `createStore` would
   deep-proxy an `EditorState`, which is both wasteful and semantically wrong
   (CM6 state is immutable and mutated only through the view's transaction cycle).
3. **What makes two "opens" the same buffer** (dedup) and what *dirty* means.

ADR-0003 (CM6 + tiered WebGL2) and ADR-0007 (single WebGL2 baseline) also constrain
us: each `EditorView` is its own DOM subtree and, under the GPU renderer, its own
canvas/context. Browsers cap WebGL contexts (~16); a view-per-tab model burns one per
open file and does not scale.

## Decision

### 1. One persistent `EditorView`; swap `EditorState` per tab

We keep **a single `EditorView` mounted** in the center editor area for the lifetime
of the app and switch tabs with **`view.setState(nextState)`**. This is the
CM6-idiomatic split: `EditorState` is the serializable per-document data (doc +
history + selection); `EditorView` is the one DOM/GPU rendering surface.

- One DOM subtree, one (future) WebGL2 canvas/context regardless of tab count.
- Each buffer owns its own `EditorState`, so history/selection survive tab switches.
- **Rejected — view-per-tab (show/hide):** N DOM subtrees and N GPU contexts; doesn't
  scale past a handful of tabs and collides with ADR-0007. Its only win (scroll is
  preserved automatically) is recovered cheaply by saving scrollTop on switch.

### 2. Reactive *metadata* in a store; CM6 *state* in plain Maps

The tab strip needs reactive primitives; CM6 must not be proxied. We split ownership:

| Data | Home | Reactive? |
| --- | --- | --- |
| `tabs: TabMeta[]` (`id`, `path`, `name`, `dirty`), `activeId` | `createStore` in `src/editor/buffers.ts` | ✅ drives the tab bar |
| `EditorState` per buffer | plain `Map<id, EditorState>` | ❌ stashed on switch |
| `savedText` per buffer (on-disk snapshot) | plain `Map<id, string>` | ❌ dirty baseline |
| `scrollTop` per buffer | plain `Map<id, number>` | ❌ restored on switch |

The **live truth for the active buffer is `view.state`**, not the Map — the Map entry
for the active id is stale until the next stash. Therefore:

- **On tab switch** (`activeId` changes), the `Editor` component — the only holder of
  the view — stashes `view.state` and `view.scrollDOM.scrollTop` into the Maps under
  the *outgoing* id, then `view.setState(states.get(incomingId))` and restores
  scrollTop after the next measure.
- **Saving** reads the active buffer's text from `view.state.doc` (live), inactive
  buffers from their stashed state.

### 3. Dirty = baseline compare, not a sticky flag

A buffer is dirty when its current text differs from its on-disk snapshot:
`dirty(id) = liveText(id) !== savedText(id)`. This correctly **clears the dot when an
edit is undone back to the saved content** — a sticky boolean cannot. Recompute only
for the active buffer on real edits; short-circuit on length for very large docs.

> ⚠️ **Gotcha:** `view.setState()` also fires the `updateListener`, and its
> `update.docChanged` is `true` when the new document differs from the old. Guard real
> edits with **`u.transactions.length > 0`** — a `setState` swap produces an update with
> *no* transactions, so this distinguishes a genuine keystroke from a tab switch and
> prevents mis-attributing dirtiness across buffers.

### 4. Buffer identity & open-file dedup

Identity key is **`path ?? "untitled:" + n`**:

- **On-disk files** are keyed by absolute path. Opening a path that is already open
  **activates the existing tab** instead of creating a duplicate.
- **Loose/unsaved buffers** (`path === null`) get a monotonic synthetic id; they are
  never deduped. On first save, the buffer keeps its synthetic id (simplest; the path
  is recorded for display and future dedup against *new* opens).

Tab order is the `tabs[]` array order; new tabs append.

### 5. Close behavior & the always-mounted invariant

- Closing a **dirty** tab confirms first (`window.confirm` for v0; a styled modal is a
  later polish — noted, not built here).
- Closing the active tab activates a **neighbor** (prefer right, else left).
- **The editor is never empty:** closing the last tab opens a fresh `untitled` buffer.
  This preserves "one view, always mounted" and avoids an empty-state code path in v0.

### 6. Language per buffer (free consequence)

Because each buffer builds its own `EditorState`, the language extension is chosen per
file at creation (`languageFor(name)`), not hard-wired to `javascript()`. v0 maps
js/ts/jsx/tsx → the JS/TS language; everything else is plain text. Richer language
selection rides ADR-0003's Lezer↔Tree-sitter bridge later.

## Consequences

- **Component shape:** new `src/editor/buffers.ts` (store + Maps + actions:
  `openOrActivatePath`, `openLoose`, `activate`, `close`, `markSaved`); new
  `src/editor/TabBar.tsx` (renders `tabs[]`, click-activate, `×` close, `•` dirty,
  right-click → reuse `ContextMenu` for Close / Close Others / Close All). `Editor.tsx`
  becomes driven by `activeId` (stash-and-swap). `App.tsx` drops its `file`/`dirty`
  signals and routes Open/Save/`requestOpenFile` through the buffer store.
- The `requestOpenFile` bridge (`src/workspace/store.ts:44`) now lands in
  `openOrActivatePath`, giving explorer-click dedup for free.
- Memory is O(open tabs) in `EditorState` size — acceptable; large files are the cost
  driver, not tab count. A future "close inactive after N" policy can evict Map entries
  without touching this model.
- Scroll restoration depends on CM6's async measure cycle; restore scrollTop in a
  post-`setState` measure callback, not synchronously.
- Establishes the reusable rule for this codebase: **reactive UI metadata in Solid
  stores; framework-owned mutable engines (CM6, future terminals) in plain refs/Maps
  the owning component drives imperatively.**
