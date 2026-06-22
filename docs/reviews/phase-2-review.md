# Phase 2 — End-of-Phase Review (Tree-sitter syntax engine)

**Phase:** 2 — Tree-sitter syntax
**Date:** 2026-06-17
**Reviewer model:** Opus 4.8 (north-star whole-system pass)
**Protocol:** [end-of-phase-review.md](../process/end-of-phase-review.md)
**One-line verdict:** **PASS-WITH-FOLLOWUPS** — intra-phase remediation complete and re-verified (2026-06-17); two future-roadmap items written into roadmap.md. Phase 3 may begin.

> The shipped artifact is genuinely strong: a clean single-threaded worker, a faithful stale-then-reconcile bridge, theme-as-data token colours, no `unsafe`, no hardcoded paths, well-sized files. The findings are about **contract fidelity to ADR-0041** and **test health**, not architecture.

---

## Inputs read

| Source | Result |
|---|---|
| [vision.md](../design/vision.md) thesis pillars · [ADR-0041](../adr/0041-tree-sitter-syntax-engine.md) · [ADR-0003](../adr/0003-editor-surface-cm6-plus-webgl2.md) · [ADR-0005](../adr/0005-builtin-ide-frameworks.md) · [ADR-0019](../adr/0019-theme-and-icon-system.md) | drift + amendment checks |
| [roadmap.md](../design/roadmap.md) Phase 2 | goals (Axis C reconstructs independently first) |
| Codebase: `src/syntax/{worker,mod,grammars}.rs`, `sindri-core/src/captures.rs`, `src/editor/syntax.ts`, `src/editor/buffers.ts`, `src/editor/theme.ts`, `ext_cmds.rs` grammar resolution | engineering reality |
| Test suite (`cargo test --workspace`) | **48 passed · 1 ignored · 0 failed** ✅ |

---

## Findings

### Axis A — Vision & Decision Integrity

| # | Finding | Tag | Disposition |
|---|---|---|---|
| **A1** | **Thesis (language-agnostic / everything-is-an-extension):** file→language association lives in a **hardcoded 13-entry `languageIdFor()` switch** ([buffers.ts:73](../../src/editor/buffers.ts#L73)), not driven by data/extension contribution. A grammar contributed for a language *outside* that switch (Zig, Nim, Elixir…) registers in the worker but **no buffer is ever assigned its `languageId`**, so it never highlights. The long-tail breadth that is Phase 2's whole rationale is the case that silently doesn't work. | 🟡 | ADR-0041 addendum (document reality) + roadmap insertion @ Phase 8 |
| **A2a** | **Decision drift — ADR-0041 §5:** the ADR says `contributes.grammars[].extensions` provides the "file-extension → languageId association." In code that field is collected and **`#[allow(dead_code)]`** ([worker.rs:100](../../src-tauri/src/syntax/worker.rs#L100)); association is the hardcoded switch instead. | 🟡 | ADR-0041 addendum (same as A1) |
| **A2b** | **Decision drift — ADR-0041 §4:** "Highlight queries are **viewport-ranged**, never whole-document — a 50k-line file must not produce a 50k-span payload." But `ts_open` queries `0..text.len()` ([worker.rs:174](../../src-tauri/src/syntax/worker.rs#L174)) and `_doOpen` ships the whole doc + receives whole-doc spans. The code comment *acknowledges* the divergence ("always returns the full doc highlights"), which makes it an undocumented decision against the ADR. | 🟡 | **A4 amendment** (bless a size threshold) **+ size guard** (intra-phase) |
| **A3** | **Undocumented decisions:** the per-doc `WasmStore` model, end-to-start splice for text maintenance, `${bufferId}:${seq}` docId scheme, and 50ms debounce are real choices made mid-phase. They're well-captured in HANDOVER but not in the ADR. Low stakes (implementation detail, not contested). | 🟢 | accept; HANDOVER suffices |
| **A4** | **ADR amendment surfacing:** see the dedicated table below — §4 (whole-doc open) and §5 (extension form `".rs"` vs `"rs"`, dead association field). | — | §A4 table |
| **A5** | **Doc truth:** HANDOVER + ADR claim item 4 delivers "extension grammars override built-ins" and "a new language just works." Override works for any of the 13 switch languages; "any new language" does **not** (A1). HANDOVER overstates the seam. | 🟡 | corrected via this review + addendum |

### Axis B — Engineering & Architecture Health

| # | Finding | Tag |
|---|---|---|
| **B1 file size** | All Phase 2 files comfortably in target: worker.rs 294 · mod.rs 146 · grammars.rs 44 · captures.rs 112 · syntax.ts 325 (🟡 frontend >300 but cohesive — single bridge with unavoidable byte↔char + IPC + ViewPlugin concerns; not splitting). | ✅ |
| **B2 decomposition** | `src/syntax/` is cleanly split (worker / commands / builtins). WASM + `.scm` assets correctly **externalised** via `include_bytes!`/`include_str!`, not inlined. Exemplary per B2. | ✅ |
| **B3 styling** | `cm-ts-<token>` colours all sourced from `def.syntax.*` theme tokens ([theme.ts:79-96](../../src/editor/theme.ts#L79)) — theme-as-data (ADR-0019). No magic literals in Phase 2 code. (Pre-existing rainbow-bracket hex literals in theme.ts:51-64 are Phase 1 scope, not this review.) | ✅ |
| **B4 dead code** | `GrammarDef.extensions` is `#[allow(dead_code)]` — a live symptom of A2a, not benign. Resolved when the association is wired (Phase 8) or by explicit deferral note. | 🟡 |
| **B5 unsafe** | **Zero** `unsafe` in the syntax engine. ✅ | ✅ |
| **B6 tests-in-own-files** | `captures.rs` uses idiomatic `#[cfg(test)] mod tests` inline (29 lines — acceptable, under the "large inline module" smell). | ✅ |
| **B7 test health** | ⚠️ **The gap.** Only `capture_to_token` is tested. The genuinely bug-prone code — `edit_doc` offset/splice arithmetic, end-to-start ordering, `posToByteOffset`/`byteOffsetToPos`/`byteCol`, and `_doEdit` delta derivation (multi-line `newEndRow/Col`) — has **zero coverage**. This is exactly the silently-corrupting class of code the gate exists to catch. | 🟡 → **intra-phase** |
| **B8 paths** | No hardcoded OS dirs in syntax engine. Dev-grammar resolution uses `Path::join` off the bundle dir. ✅ | ✅ |
| **B9 error boundaries** | Worker commands return typed `Result<_, String>`; IPC failures map to `"syntax worker offline"`. One guarded `.unwrap()` ([worker.rs:205](../../src-tauri/src/syntax/worker.rs#L205)) is **safe** (preceded by the `get(&doc_id)?` existence check) — a `let-else`/`expect("checked above")` would read cleaner. Frontend `_doEdit`/`_doHighlight` swallow errors (`.catch(() => {})`) — correct for stale-then-reconcile resilience, but a perpetually-failing query then yields no highlights with **no diagnostic**. | 🟢 |
| **B10 deps** | `tree-sitter 0.26` (+`wasm` feature → wasmtime), `streaming-iterator 0.1`. Both justified in ADR-0041, confined to the `sindri` app crate (CLI stays lean per §2). Licenses MIT/Apache — AGPL-/project-compatible. ✅ | ✅ |
| **B11 idiom/boundary** | snake_case→camelCase IPC contract honoured (`#[serde(rename_all = "camelCase")]` on `InputEditDelta`; JS sends camelCase). Worker channel + oneshot reply is idiomatic. Reads like its neighbours. ✅ | ✅ |
| **B-perf** | **`Query::new(language, scm)` is recompiled on every `ts_open`/`ts_edit`/`ts_highlight`** ([worker.rs:268](../../src-tauri/src/syntax/worker.rs#L268)) — i.e. the `.scm` query is re-parsed per keystroke (debounced) and per scroll. Directly taxes the ADR-0041 §4 / ADR-0003 perf budget. Cheap fix: compile once per `DocState`, reuse. | 🟡 → **intra-phase** |

### Axis C — Phase Completeness & Gap Analysis

**C1 — first-principles reconstruction** (before consulting the checklist). A complete "tree-sitter syntax" phase needs: (a) a Rust-owned parser with incremental reparse; (b) async stale-then-reconcile decoration bridge; (c) viewport-ranged queries for large files; (d) bootstrap grammars so it works out of the box; (e) a runtime path for **arbitrary new languages** to light up without a rebuild; (f) standard-capture→theme-token mapping; (g) UTF-8/UTF-16 correctness; (h) lifecycle (open/edit/scroll/close) + multi-view isolation. Diffing against shipped:

| # | Finding | Tag | Disposition |
|---|---|---|---|
| **C1/C2** | (a),(b),(d),(f),(g),(h) — **all shipped and coherent.** Incremental `tree.edit()` reparse, stale-map-through-changes, two bundled grammars, capture map, byte↔char walking, per-view `docId` isolation, retry-on-grammar-not-found. Strong. | ✅ | — |
| **C2** | (c) viewport-ranging is implemented for `ts_edit`/`ts_highlight` but **not `ts_open`** (= A2b). | 🟡 | intra-phase (A2b) |
| **C3 deferred-items audit** | (e) "arbitrary new language just works" is the **deferred hole** (A1/A2a): mechanism present (worker registration + override), association missing. Deferral is *acceptable* only because every roadmap language through Phase 13 (Rust/TS/Go/Python/Java/web) is already in the hardcoded switch — the break first bites Phase 14 community long-tail. So: defer **consciously**, with the fix scheduled at Phase 8 (when the language-pack pattern is canonicalised) and an ADR addendum now. | 🟡 | roadmap @ Phase 8 + ADR addendum |
| **C4 seam check** | The `ts_register_grammar` override seam Phase 8's `sindri.rust.grammar` consumes **works** (rust ∈ switch). The reserved seam is coherent for the next consumer. ✅ (the *language-agnostic* seam is the C3 gap.) | ✅ | — |
| **C5 scope creep** | None. Nothing premature built. | ✅ | — |
| **C6 coherence** | Features compose into a working whole: open a `.rs`/`.ts` file → live incremental highlighting that survives edits and scroll. The one integration seam left implicit is **silent-failure observability** (B9) — acceptable for now. | ✅ | note |

---

## ADR amendment proposals (A4 — first-class output)

| ADR-§ | Proposed change | Why |
|---|---|---|
| **ADR-0041 §4** | Amend the "never whole-document" rule to: *highlight queries are viewport-ranged for any document above a byte threshold `T`; below `T`, `ts_open` MAY return full-document highlights as a convenience.* Pick `T` (proposal: 128 KiB). Implement the guard so the contract and code agree. | Code already diverges (whole-doc open); the divergence is reasonable for small files but must be **bounded** so a 50k-line file doesn't blow the payload — the ADR's actual intent. |
| **ADR-0041 §5** | (1) Add an **addendum** recording that file→`languageId` association is presently a hardcoded frontend switch (`languageIdFor`), and that the `extensions` field is **reserved/not-yet-wired**, with the dynamic-association work scheduled at Phase 8. (2) Fix the example's `"extensions": [".rs"]` → `["rs"]` (no leading dot) to match `languageIdFor`'s `ext.split(".").pop()` and the built-in seed. | Keeps the ADR honest about the seam gap (A1/A2a) and removes the dot-form trap that bites the moment the field is wired. |

> ADR amendments are written as an **addendum to ADR-0041** (append-only; decision not reversed, contract clarified) — see [ADR-0041 §Addendum 2026-06-17](../adr/0041-tree-sitter-syntax-engine.md).

---

## Remediation plan

### 🔴 Intra-phase remediation roadmap — **HARD GATE** (all done + re-verified before Phase 3)

Ordered. Mostly mechanical → **type on Sonnet 4.6**; the design calls below are locked here on Opus.

1. **Cache the compiled `Query` per `DocState`** (B-perf). Compile once on first highlight (or at open), store `Option<Query>` on `DocState`, reuse across edit/highlight. Invalidate only on grammar re-register for that doc. Kills per-keystroke `.scm` re-parse.
2. **Bound `ts_open` to a size threshold** (A2b/C2). Below `T` (128 KiB): current full-doc behaviour. At/above `T`: require viewport bounds and range-limit — add `viewport_start/end` params to `ts_open` (+ `_doOpen` passes the initial viewport). Land alongside the ADR-0041 §4 amendment.
3. **Close the B7 test gap.** (a) Rust: a worker integration test that loads the **bundled** Rust grammar, opens a small snippet, asserts expected `(token, span)` highlights, then applies an `InputEditDelta` and asserts the reparse — covers the offset/splice arithmetic end-to-end. (b) TS: unit tests for `posToByteOffset`/`byteOffsetToPos`/`byteCol` over ASCII + multibyte (CJK/emoji) fixtures, and a `_doEdit` multi-line delta derivation case.

**Re-verify:** `cargo test --workspace` green (new tests included) + `bun run typecheck` clean.

### 🟡/🟢 Future-roadmap insertions (written into roadmap.md with back-reference)

| Item | Target | Back-ref |
|---|---|---|
| **Dynamic file→`languageId` from contributed grammar `extensions`** — drive association from the worker's grammar registry (a `ts_grammar_languages` query or push-on-register), layered over the hardcoded defaults; retires `#[allow(dead_code)]`. Makes "new language just works" actually true. | **Phase 8** (language-pack anatomy) | A1/A2a/C3 |
| **Highlight-query failure observability** — debug-log when a viewport query yields nothing because `Query::new`/parse failed, instead of silent `.catch(() => {})` / `Err → vec![]`. Fold into ADR-0030 output logging. | **Phase 7** (crash/dispose discipline) or editor-hardening | B9/C6 |

---

## Verdict & gate status

| | |
|---|---|
| **Gate 1 — Review** | ✅ complete (this artifact). No 🔴 blockers. |
| **Gate 2 — Intra-phase remediation** | ✅ **COMPLETE** (2026-06-17) — all 3 items executed and re-verified. |
| **Verdict** | **PASS-WITH-FOLLOWUPS** — Phase 3 may begin. Future-roadmap insertions written into roadmap.md. |

### Re-verification (2026-06-17)

| Check | Result |
|---|---|
| `cargo test --workspace` | ✅ **53 passed** · 1 ignored · 0 failed (sindri lib: 25 [+5 worker integration tests]; sindri-core: 25; sindri-cli: 3) |
| `bun run typecheck` | ✅ clean |
| `bun run test` (vitest) | ✅ **30 passed** (4 test files; +6 syntax-utils tests) |

### Intra-phase items — what shipped

1. **Query caching** — `query: Query` added to `DocState`; compiled once at `open_doc`; reused in `edit_doc`/`highlight_doc`. `query_highlights` now takes `&Query` directly. Dead snapshot of `language_id`/`highlights_scm` in `edit_doc` eliminated; `Language` dropped from `DocState`.
2. **`ts_open` size threshold** — `FULL_DOC_THRESHOLD = 128 KiB`; below it: full-doc highlights (unchanged behaviour); at/above: viewport-ranged. `ts_open` command gains `viewport_start/viewport_end`; `_doOpen` in `syntax.ts` passes initial viewport bytes.
3. **Tests** — Rust: 5 integration tests in `src/syntax/tests.rs` (open highlights, incremental reparse, splice end-to-start ordering, unknown language error, re-open idempotence). TS: 6 unit tests in `src/__tests__/syntax-utils.test.ts` covering `posToByteOffset`/`byteOffsetToPos`/`byteCol` over ASCII + CJK + emoji, and `_doEdit` multi-line delta derivation.
</content>
</invoke>
