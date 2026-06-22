# ADR-0041 — Tree-sitter syntax engine (WASM grammars, Rust-core worker, stale-then-reconcile CM6 bridge)

**Status:** Accepted — 2026-06-17

**Phase:** 2 (Tree-sitter syntax) — kickoff design fork.

**Relates to:** ADR-0003 (editor surface — the "tree-sitter highlighting is never synchronous with a scroll frame" hard rule and the Lezer-vs-Tree-sitter note), ADR-0005 (language-agnostic thesis), ADR-0006 (extension API from day one), ADR-0019 (theme-as-data), ADR-0035 (extension WASM via V8).

---

## Context

Phase 2 makes syntax highlighting work for *any* language without a per-language Lezer grammar (ADR-0005). ADR-0003 already bound two decisions we are **not** re-litigating:

1. **Tree-sitter lives in the Rust core, not the webview.** Rust is the structural source of truth; CM6 receives highlight spans as decorations. The simpler `web-tree-sitter`-in-JS path is rejected — it would make the webview the structural authority and fork the parse state away from where LSP/SAP/DAP will later consume it.
2. **Highlighting is asynchronous and never blocks a scroll frame** — paint known/stale tokens immediately, reparse in Rust, reconcile (ADR-0003 "Hard rule").

CM6 owns the canonical live document (ADR-0003); Rust does **not** mirror a rope. So the frontend ships *edits* to Rust, and Rust holds only the parse `Tree` + `Parser` per open document.

The remaining design forks — resolved here — are: **how grammars are delivered**, **where the engine lives**, **how parse state is threaded**, **the IPC surface**, and **how captures map to theme colors**.

---

## Decision

### 1. Grammars are WASM, loaded at runtime via wasmtime

Grammars ship as tree-sitter `.wasm` files loaded at runtime through the `tree-sitter` crate's `wasm` feature (backed by `wasmtime`). We do **not** compile grammars natively into the binary.

**Why WASM from the start (not native-first):** the Phase 2 grammar loader (`contributes.grammars[].path`, item 4) is *inherently* runtime WASM loading — there is no other way for an extension to contribute a grammar without re-shipping Sindri. Since item 4 lands **this phase**, a native-compiled bootstrap path would be throwaway work on the critical path. One code path, from day one.

> **Two WASM runtimes now coexist, by necessity.** Extension modules (`sindri.wasm.load`, ADR-0035) run in **V8's** WebAssembly via deno_core. Grammars run in **wasmtime** via tree-sitter's `wasm` feature. They cannot be merged: tree-sitter's wasm support is wasmtime-specific and depends on the tree-sitter wasm ABI. Accepted cost.

Illustrative load path (conceptual — not a literal API contract):

```rust
use tree_sitter::{Parser, WasmStore};
use tree_sitter::wasmtime::Engine;

let engine = Engine::default();                       // one per worker, shared
let mut store = WasmStore::new(&engine)?;             // owns instantiated grammars
let language = store.load_language("rust", &wasm)?;   // wasm bytes from registry
let mut parser = Parser::new();
parser.set_wasm_store(store)?;
parser.set_language(&language)?;
```

### 2. Engine home — `sindri` app crate, not `sindri-core`

The parsing worker (wasmtime + tree-sitter) lives in the **`sindri` app crate** under `src/syntax/`. It does **not** go in `sindri-core`, because the CLI (`sindri ext`, also built from `sindri-core`) never parses source and must not pull in wasmtime.

Split:

| Lives in | What |
|---|---|
| `sindri-core` | the `GrammarEntry` manifest type (§5) and the canonical capture→token name set (§6) — no wasmtime dependency |
| `sindri` app `src/syntax/` | the worker, `WasmStore`, per-doc `Parser`/`Tree`, IPC commands, highlight queries |

### 3. Single-threaded syntax worker owns all parse state

`WasmStore` is **not `Sync`**, and parsing must never run on the UI/IPC thread (ADR-0003). Both constraints are satisfied by a **single dedicated syntax worker** (one thread / long-lived task) that owns:

- one `wasmtime::Engine`,
- one `WasmStore` **per language** (grammars instantiated once, reused across docs),
- a `DocState` map: `docId → { languageId, parser, tree }`.

IPC commands enqueue a request to the worker over a channel; the worker parses and returns highlight spans asynchronously. The worker is the *only* place tree-sitter state is touched — no locks, no `Send`/`Sync` gymnastics across grammars.

Edits are applied incrementally: the frontend sends `InputEdit` deltas (byte + row/column points), the worker calls `tree.edit(...)` then reparses with the prior tree as the baseline — true tree-sitter incrementality, not full re-parse per keystroke.

### 4. IPC surface — viewport-ranged, async, fire-and-reconcile

Tauri commands (snake_case Rust → camelCase JS per the HANDOVER gotcha):

| Command | Purpose |
|---|---|
| `ts_open(doc_id, language_id, text) → Highlight[]` | open a doc; full parse; return highlights for the initial viewport |
| `ts_edit(doc_id, edits, viewport_start, viewport_end) → Highlight[]` | apply incremental edits; return highlights for the current viewport |
| `ts_highlight(doc_id, viewport_start, viewport_end) → Highlight[]` | re-query highlights for a new viewport (scroll) without editing |
| `ts_close(doc_id)` | drop the doc's `Tree`/`Parser` |
| `ts_register_grammar(language_id, wasm, highlights_scm, extensions)` | register a grammar into the worker registry (built-in seed + grammar loader, §5) |

**Highlight queries are viewport-ranged** (visible range ± a margin), never whole-document — a 50k-line file must not produce a 50k-span payload. tree-sitter's query cursor is range-limited via `set_byte_range`. Reparse is full-tree-incremental (cheap); the *highlight query* is the part scoped to the viewport.

`Highlight` shape:

```ts
type Highlight = { start: number; end: number; token: string }  // byte offsets + capture-derived token
```

### 5. Grammar contribution shape + built-in seed

`contributes.grammars[]` upgrades from bare `PathEntry` to a `GrammarEntry`:

```jsonc
"grammars": [
  {
    "language": "rust",                       // languageId the editor assigns to a buffer
    "path": "grammars/rust.wasm",             // tree-sitter wasm grammar
    "highlights": "grammars/rust/highlights.scm", // capture query (§6)
    "extensions": [".rs"]                      // file-extension → languageId association
  }
]
```

- **Built-in seed (item 3):** Rust and TypeScript grammars + their `highlights.scm` ship as **bundled core assets**, registered into the worker at startup so the editor highlights out of the box with no extension installed. Syntax highlighting is core editor infrastructure (like the minimap, ADR-0026 §1), not an extension feature — bundling the bootstrap pair is consistent with that.
- **Grammar loader (item 4):** at extension activation, the host reads `contributes.grammars[]`, resolves the WASM + `.scm` from the bundle (zip-aware, like ADR-0035 WASM modules), and calls `ts_register_grammar`. Extension-contributed grammars **override** a built-in of the same `language` (so `sindri.rust.grammar` in Phase 8 can supersede the bootstrap Rust grammar without a Sindri rebuild).

### 6. Captures → theme tokens — standard names, core map, theme-as-data colors

Grammars provide a `highlights.scm` query that tags nodes with **standard tree-sitter capture names** (`@keyword`, `@function`, `@string`, `@comment`, `@type`, `@variable`, `@number`, `@constant`, `@operator`, `@property`, `@punctuation.*`, …). The worker maps each capture to a fixed **token name** (the canonical set lives in `sindri-core`), and the `Highlight.token` is that name.

The CM6 bridge applies a decoration with class `cm-ts-<token>`; the theme system (ADR-0019, theme-as-data) supplies the color for each `cm-ts-<token>` via theme tokens. Grammars stay portable (standard captures); themes stay data; the editor owns the small, stable capture→token vocabulary.

### 7. CM6 bridge — stale-then-reconcile (ADR-0003 hard rule)

A CM6 `StateField<DecorationSet>` holds the current highlight decorations; a `ViewPlugin` watches viewport + document changes. On any change:

1. **Immediately** keep the existing (now possibly stale) decorations — the frame is never blocked.
2. Fire the relevant IPC command (`ts_edit` / `ts_highlight`), **debounced**, **not awaited** on the update path.
3. On resolve, dispatch a transaction that replaces decorations for the queried range with the fresh spans (mapping byte offsets → positions, `token` → `cm-ts-<token>` mark).

This is the literal implementation of ADR-0003's "render known/stale tokens immediately, reparse async in Rust, reconcile."

---

## Consequences

- **wasmtime enters the dependency tree now** (sizeable). Confined to the `sindri` app crate; the CLI stays lean.
- **Two WASM runtimes** (V8 for extension modules, wasmtime for grammars) — accepted; they serve different layers and cannot share an engine.
- A new language "just works" by registering a grammar — no Sindri rebuild. This is the ADR-0005 payoff and the seam Phase 8's `sindri.rust.grammar` extension consumes.
- Parse state is single-threaded and centralized — easy to reason about, and the natural place LSP/SAP later read structural context. No cross-thread grammar sharing.
- Cost: the viewport-ranged query + debounce + reconcile dance is real frontend complexity, and stale-paint means a sub-frame window where freshly-typed text shows old colors. That window is the explicit, accepted trade in ADR-0003.
- `GrammarEntry` is a manifest schema change; `validate()` must learn the new required fields (`language`, `path`, `highlights`).

---

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **`web-tree-sitter` in the webview (JS)** | ✗ | Simplest to wire, but makes the webview the structural source of truth — contradicts ADR-0003 and forks parse state away from the Rust core where LSP/SAP/DAP will consume it. |
| **Native-compiled grammars first, WASM loader later** | ✗ | Lower-risk bootstrap, but item 4 (runtime grammar loading) lands *this* phase and forces wasmtime regardless — the native path would be throwaway work on the critical path. |
| **Per-language Lezer grammars** | ✗ | ADR-0003's breadth argument: far fewer quality grammars than tree-sitter. Lezer stays available where a good grammar already exists, but is not the breadth strategy. |
| **Whole-document highlight queries** | ✗ | A large file yields an enormous span payload per change. Viewport-ranged queries are mandatory for the ADR-0003 perf budget. |
| **Multi-threaded worker / `Tree` shared across threads** | ✗ | `WasmStore` is non-`Sync`; a single worker sidesteps the constraint and keeps parse state lock-free. Revisit only if one worker becomes a bottleneck across many open docs. |

---

## Addendum — 2026-06-17 (Phase 2 End-of-Phase Review)

Surfaced by the [Phase 2 review](../reviews/phase-2-review.md). The decision is **not reversed**; two clauses are clarified to match shipped reality and bound a perf rule.

### §4 — `ts_open` is whole-document below a size threshold

The "highlight queries are viewport-ranged, **never** whole-document" rule (§4) is amended to be **threshold-bounded**:

- For a document **below `T = 128 KiB`**, `ts_open` MAY return full-document highlights as an initial-paint convenience (current behaviour).
- For a document **at/above `T`**, `ts_open` MUST be viewport-ranged like `ts_edit`/`ts_highlight` (caller passes initial viewport bounds; the worker range-limits the query).

The §4 intent — *a 50k-line file must never produce a 50k-span payload* — is preserved; small files are exempted explicitly rather than by accident. The guard ships in the Phase 2 intra-phase remediation.

### §5 — file→`languageId` association is presently hardcoded; `extensions` is reserved

§5 presents `contributes.grammars[].extensions` as the "file-extension → languageId association." **As shipped, it is not yet wired:** association is a hardcoded frontend switch (`languageIdFor()` in `buffers.ts`), and the worker's `extensions` field is carried but unused (`#[allow(dead_code)]`). Consequence: an extension grammar for a language **outside** that switch registers but never highlights, because no buffer is assigned its `languageId`.

This is acceptable **only** because every roadmap language through Phase 13 (Rust, TypeScript, Go, Python, Java, web) is already in the switch; the gap first bites Phase 14 community long-tail packs. The dynamic association — drive file→`languageId` from the worker's grammar registry, layered over the hardcoded defaults — is **scheduled at Phase 8** (language-pack anatomy), tracked in [roadmap.md](../design/roadmap.md) with a back-reference to the Phase 2 review.

Also: the §5 example's `"extensions": [".rs"]` should read `["rs"]` (no leading dot) — `languageIdFor` derives the key via `ext.split(".").pop()` and the built-in seed registers `"rs"`. The leading-dot form must not be reintroduced when the field is wired.
