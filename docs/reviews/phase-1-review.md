# Phase 1 — End-of-Phase Review

- **Phase:** 1 — Extension infrastructure
- **Date:** 2026-06-17
- **Reviewer model:** Opus 4.8 (Fable 5 retired; Opus 4.8 is now the top tier — see [F-DOC-1](#f-doc-1))
- **Protocol:** [end-of-phase-review.md](../process/end-of-phase-review.md)
- **One-line verdict:** **BLOCKED → pending a small, mostly-mechanical intra-phase remediation roadmap.** No correctness defects in shipped behaviour (Rust suite 35/35 green, no `unsafe`, no path bugs); the must-fix bucket is engineering-hygiene debt that compounds if carried into Phase 2 — chiefly the **total absence of frontend test infrastructure** and a **god-file/decomposition** pass.

> This is the healthy outcome of a working gate: the phase shipped its functional goals, and the review found real, addressable debt to clear before Phase 2 piles on top of it. Nothing here questions the *design* — the architecture is sound and the ADR hygiene is genuinely good (every superseded decision is tracked: 0015→0025, 0020§3→0038, 0032§6→0038, 0026 revised, 0022 addendum).

---

## 1. Findings

### Axis A — Vision & Decision Integrity

| # | Finding | Tag | Disposition |
|---|---|---|---|
| **A1-human** | Human-first held. Phase 1 added zero AI-native defaults; the one AI surface (assistant panel) is explicitly deferred to Phase 14, opt-in, provider-agnostic. | 🟢 | accept |
| **A1-poly** | Polyglot-first held. All Phase 1 work is language-agnostic host/API/distribution infra; no language was baked into the core. Language packs remain Phase 8+. | 🟢 | accept |
| **A1-ext** | Everything-is-an-extension held *as forcing function*: real extensions (`sindri-now-playing`, `sindri-ferris-says`, `sindri-rune-oracle`) were built on the public API + a full author CLI. **Caveat:** the Search/Git/Debug/Problems activity-bar slots are still hard-coded placeholders in `builtins.ts` — acceptable (those features aren't built yet), but ADR-0022's status must reflect this. → see A4-22. | 🟡 | track via A4-22 |
| **A2** | No undocumented code/ADR drift found. Notably, the suspected B3 "raw-CSS violation" is **not** drift — ADR-0019 explicitly designs around `styles.css` + CSS custom properties. The protocol's B3 rule is the thing that's wrong, not the code. → see A4-proto. | 🟢 | accept |
| **A3-license** | **Undocumented decision:** all three `Cargo.toml` declare `license = "MIT OR Apache-2.0"`, with no ADR rationalizing it, contradicting the stated AGPL preference. | 🟡 | **write licensing ADR** ([ADR-0039](../adr/0039-project-license.md)) |
| **A5-handover** | HANDOVER claims "All Phase 1 work is done." Mostly true, with two asterisks: the frontend-test vacuum (B7) and ADR-0022 status. | 🟢 | corrected by this review + remediation |

### Axis B — Engineering & Architecture Health

| # | Finding | Tag | Disposition |
|---|---|---|---|
| **B1/B2-rust** | God-files: `exthost/runtime.rs` **1823**, `sindri-cli/src/ext.rs` **1205**, `lib.rs` **926**, `exthost/mod.rs` **610**. `lib.rs` is a true grab-bag of unrelated Tauri commands (single-responsibility violation); `runtime.rs`/`ext.rs` are cohesive-but-oversized subsystems. | 🟡→🔴 | **`lib.rs` split = must-fix** (Phase 2 extends it directly); `runtime.rs`/`ext.rs` modularization → future roadmap |
| **B1/B2-fe** | God-components: `MarketplaceSection.tsx` **1633**, `SettingsModal.tsx` **1297**, `lib/tauri.ts` 552. Each renders/owns an entire tab/domain. | 🟡 | future roadmap (engineering-hardening slot) |
| **B3-css** | `src/styles.css` is **3767 lines** of raw CSS; 5 *static* inline styles in `SettingsModal.tsx`. **Reframed:** CSS-vs-SCSS is a false flag (ADR-0019 mandates `styles.css` + tokens). Real issues = (a) one monolithic stylesheet (size/cohesion), (b) avoidable static inline styles. | 🟡 | static inline styles → must-fix (trivial); stylesheet split → future; **amend protocol B3** (A4-proto) |
| **B5** | Zero `unsafe` anywhere. | 🟢 | accept |
| **B6** | Heavy inline test modules: `exthost/mod.rs` ~357 lines (58% of file), `runtime.rs` ~221 lines. Small inline modules (semver, paths, etc.) are fine. | 🟡 | extract the two large ones → sibling `tests.rs` (must-fix, pairs with B1-rust) |
| **B7** | **Rust:** 35/35 pass, build green, typecheck clean. **Frontend:** *zero* tests, no test script, no test infra at all — for a phase that shipped CodeMirror integration, the workbench chrome, the IPC layer, and the entire `sindri.ui` extension-binding surface (notifications, input box, tree view, quick pick, webview). | 🔴 | **must-fix** — stand up Vitest + `@solidjs/testing-library`, smoke-test the critical exthost-binding surfaces |
| **B8** | No hardcoded OS paths in source. The `Library/Logs` join is correct `#[cfg(macos)]` in the Tauri-less `sindri-core` crate. | 🟢 | accept |
| **B9** | Mutex `.lock().unwrap()` (19) acceptable. Two genuinely fallible runtime unwraps: `lib.rs:238` (`tmp_bundle.to_str().unwrap()`), `lib.rs:502` (`Response::builder().body().unwrap()`). | 🟡 | must-fix (trivial → `map_err`) |
| **B10** | Dead frontend devDeps: `svelte`, `esbuild-svelte`, `svelte-preprocess` (SolidJS app, no `.svelte` files, no Vite plugin). License mismatch → A3-license. | 🟡 | remove dead deps (must-fix, trivial) |
| **B11** | Naming/idiom/IPC camelCase seam intact; tests pass; no flags. | 🟢 | accept |

### Axis C — Phase Completeness & Gap Analysis

**C1 — first-principles reconstruction.** A complete "extension infrastructure" phase (derived from vision §6 *before* consulting the checklist) needs: ① an isolated host runtime, ② an activation/lifecycle model, ③ a public API broad enough to carry real features (UI, editor, fs, exec, output, config, resources, wasm/native, l10n), ④ distribution (manifest, packaging, install, registry, marketplace, update), ⑤ author DX (CLI, templates, previewers, debugging), ⑥ a security model. Diffing that ideal against what shipped:

| # | Finding | Tag | Disposition |
|---|---|---|---|
| **C-built** | ①–⑥ all substantially present: Deno/V8 per-isolate host (0025), M0–M5 lifecycle, the full API surface (0024/0030/0031/0034/0035/0036 + workspace/exec/ui), distribution (0020/0038/.sinxt/install), DX (0033 CLI/0032 templates/previewers/0037 inspector), brokered exec security (0027). The phase genuinely built what it should. | 🟢 | accept |
| **C2-apiver** | **Unenumerated gap:** no extension **API-version compatibility gate**. An extension never declares which `@sindri/api` version it targets, and the host can't refuse an incompatible one. This is a *ruinous-to-retrofit seam* — it should exist before third parties build against the API. | 🟡 | future roadmap (early — before ecosystem opens; candidate for a 1.6 / Phase 2 prep) |
| **C2-state** | **Unenumerated gap:** no extension-managed **state-persistence API** (VSCode `globalState`/`workspaceState` analogue). ADR-0023 covers user *configuration*, not extension-owned key/value state. | 🟢 | backlog → Phase 7 (or when first extension needs it) |
| **C2-crash** | **Unenumerated gap:** extension **crash/error-boundary + dispose discipline** is unspecified. If an isolate throws on activation or a contribution leaks (panel/status-bar/listener not torn down on disable/uninstall), the host behaviour is undefined. | 🟡 | future roadmap → Phase 7 (trust/security hardening) |
| **C3** | Deferred-items audit: `sindri-csv-grid`→Phase 3.3 (needs `registerEditor`), minimap = core feature not extension, zstd→post-Phase 7, typed-contribution channel→Phase 5, ADR-0028/0029 reserved seams. **All deferrals still correct.** | 🟢 | confirm |
| **C4** | Seam check: 0028 (`registerEditor`), 0029 (overlay), 0009 (`Environment` trait) reserved and coherent. The one *missing* seam is C2-apiver. | 🟡 | covered by C2-apiver |
| **C5** | No premature next-phase scope creep observed. | 🟢 | accept |
| **C6** | Coherence: features compose into a usable whole (CLI authors → bundles → installs → activates → contributes UI). The integration *risk* is unproven on the frontend due to B7 — the `sindri.ui` binding surfaces have no automated proof they compose correctly. | 🟡 | mitigated by B7 must-fix |

---

## 2. ADR amendment proposals *(from A4 — first-class output)*

| Ref | Target | Proposed change | Why |
|---|---|---|---|
| **A4-22** | ADR-0022 §Status + §3 | Status `Proposed` → **`Accepted`** (the `contributes.panels` field + `registerPanel` shipped). Rewrite §3 transition plan to reference the **Deno/V8 host (ADR-0025)**, not QuickJS (ADR-0015, superseded). Note that Search/Git/Debug/Problems remain bundled placeholders pending their feature phases. | The decision is implemented; the ADR text still describes an unbuilt QuickJS world and an unshipped status. |
| **A4-proto** | [end-of-phase-review.md](../process/end-of-phase-review.md) B3 | Replace "**SCSS files only. No inline `style=`, no raw `.css`**" with: "**theme tokens via CSS custom properties (ADR-0019); no magic colour/spacing literals; no *static* inline styles** (dynamic computed styles are fine)." | The categorical SCSS-only rule directly contradicts ADR-0019, which mandates `styles.css` consuming `var(--*)`. The protocol over-specified; this aligns the check with the locked architecture. |
| **F-DOC-1** | [CLAUDE.md](../../../CLAUDE.md) model table + [end-of-phase-review.md](../process/end-of-phase-review.md) Model line + memory | Remove **Fable 5** (retired). Promote **Opus 4.8** to the top tier for north-star reviews / contested forks; keep Sonnet for mechanical work. | Fable 5 is no longer an available model; every doc that routes judgment work to it is now stale. |
| **A3-39** | *(new)* [ADR-0039](../adr/0039-project-license.md) | Record the project license decision: **MIT OR Apache-2.0 retained** (permissive, Rust-convention); AGPL considered and declined. | The license was chosen-by-omission with no rationale; ADR-0039 now makes the permissive choice explicit. |

> **Empty-result note:** no *earlier* ADR's core decision was found to be invalidated by what Phase 1 built — the supersession chain was kept current as decisions evolved. The amendments above are status/text drift and one process-doc over-specification, not reversed decisions.

---

## 3. License — recommendation & decision *(answering the open question)*

> **✅ Decision (2026-06-17): `MIT OR Apache-2.0` retained** — the project owner's call: permissive, Rust-ecosystem convention, no monetization motive for copyleft. Recorded in **[ADR-0039](../adr/0039-project-license.md)**. Cargo fields already correct; `LICENSE-MIT` + `LICENSE-APACHE` added. The analysis below is preserved as the considered alternative (AGPL) that was weighed and declined.

The review's original recommendation was **`AGPL-3.0-or-later` for the Sindri core, with an explicit extension-boundary clarification** — rationale, given the owner will not monetize:

- **Matches intent + maximizes openness.** Strong copyleft prevents anyone shipping a proprietary fork or a closed re-host of your work — the whole point of releasing it open with no commercial motive.
- **AGPL > GPL here specifically** because Sindri has a real network-service dimension: the **browser/PWA target (ADR-0017)** and **remote execution environments (ADR-0009)**. AGPL §13 closes the "host a modified Sindri as a SaaS without releasing the changes" loophole that plain GPL leaves open. For the pure-desktop case AGPL behaves identically to GPL, so it costs you nothing and protects the hosted case for free.
- **No downside for you.** The usual reason to avoid AGPL is that it deters commercial adopters — irrelevant when you're not selling.
- **Extension-ecosystem nuance (important).** Extensions run in **separate V8 isolates** communicating over a defined op/IPC protocol (ADR-0025 §2) — an arm's-length, separate-process boundary. That's a strong basis to treat third-party extensions as **independent works, not derivatives** of the AGPL core. To remove all doubt and avoid chilling the ecosystem, ship a short **linking-style exception**: *"Extensions that interact with Sindri solely through the public `@sindri/api` over the extension-host boundary are independent works and may be licensed under any terms."* Bundled first-party language packs can stay AGPL (your call).

| Option | Verdict |
|---|---|
| **MIT OR Apache-2.0** | ✅ **Chosen** (ADR-0039) — permissive, Rust-convention, frictionless reuse; proprietary forks allowed (accepted, not monetizing) |
| AGPL-3.0-or-later + extension exception | Considered, declined — strongest protection, covers web/remote, but copyleft isn't a project goal |
| GPL-3.0-or-later | Simpler but under-protects the hosted/web case AGPL covers |
| MPL-2.0 | Better for permissive extensions, but weak-copyleft under-protects the core |

→ formalized in **[ADR-0039](../adr/0039-project-license.md)**; Cargo `license` fields already correct, `LICENSE-MIT` + `LICENSE-APACHE` added.

---

## 4. Remediation plan

### 🔴 Intra-phase remediation roadmap — **HARD GATE** (all done + re-verified before Phase 2)

Ordered; the first is the substantive one, the rest are cheap-and-correct-to-clear-now:

1. **Frontend test infrastructure (B7).** Add Vitest + `@solidjs/testing-library`, a `test` script, and smoke tests covering the critical `sindri.ui` exthost-binding surfaces (notifications, input box, tree view, quick pick) + at least one workbench-chrome render test. This also retroactively proves the C6/1.2 surfaces compose.
2. **Split `lib.rs` (B1/B2-rust)** by Tauri-command domain into focused modules; **extract the large inline test modules** in `exthost/mod.rs` and `runtime.rs` to sibling `tests.rs` (B6). Re-run `cargo test --workspace`.
3. **Fix the 2 fallible unwraps (B9):** `lib.rs:238`, `lib.rs:502` → proper error propagation.
4. **Remove dead devDeps (B10):** `svelte`, `esbuild-svelte`, `svelte-preprocess`. Re-run typecheck/build.
5. **Replace the 5 static inline styles (B3)** in `SettingsModal.tsx` with token-backed classes.
6. **Doc/decision hygiene:** write **ADR-0039** (license = MIT/Apache, §3) + add `LICENSE-MIT`/`LICENSE-APACHE` (Cargo fields already correct); amend **ADR-0022** status/text (A4-22); amend **protocol B3** (A4-proto); strip retired **Fable 5** from CLAUDE.md + protocol + memory (F-DOC-1). ✅ **done this session.**

> **Model routing for remediation:** items 2–6 are mechanical → **Sonnet 4.6**. Item 1 (test infra design) is light-judgment → start on **Opus 4.8**, hand the test-writing to Sonnet.

> **Gate-severity judgment call:** items 1 and 2 are the debatable "must-fix vs defer" calls. They're gated because (a) Phase 2 extends `lib.rs` and the editor surface directly — the debt compounds, and (b) the frontend-test vacuum makes every future frontend change unverifiable. Items 3–6 are gated only because they're <1hr total and not worth carrying as rot. The user may rebalance buckets.

### 🟡/🟢 Future-roadmap insertions (written into [roadmap.md](../design/roadmap.md), back-referenced here)

| Item | Target phase | Source |
|---|---|---|
| Extension **API-version compatibility gate** (`engines.sindri` semver, host refuses incompatible) | early — **new §1.6 / Phase 2 prep** (before ecosystem opens) | C2-apiver / C4 |
| Decompose `runtime.rs` (1823), `ext.rs` (1205), `MarketplaceSection.tsx` (1633), `SettingsModal.tsx` (1297); split monolithic `styles.css` (3767) into modular stylesheets | **§1.6 engineering-hardening** (pre-Phase 2) | B1/B2-fe, B3-css |
| Extension **crash/error boundary + dispose discipline** (contribution teardown on disable/uninstall) | **Phase 7** (trust & security) | C2-crash |
| Extension **state-persistence API** (`globalState`/`workspaceState`) | **Phase 7** (or first need) | C2-state |

---

## 5. Verdict & gate status

| | |
|---|---|
| **Gate 1 — Review** | ✅ Complete (Axes A/B/C + A4 amendments + C1 reconstruction performed) |
| **Gate 2 — Intra-phase remediation** | 🔴 **Outstanding** (6-item roadmap above) |
| **Verdict** | **`BLOCKED`** — one 🔴 (frontend test vacuum) + an intra-phase remediation roadmap must be executed and re-verified. |
| **Path to PASS** | Execute §4 must-fix list, re-run `cargo test --workspace` + new frontend suite + typecheck green, then flip this verdict to `PASS` (append-only addendum). **Phase 2 may not begin until then.** |

> Design integrity is **strong** — this BLOCK is about hygiene debt, not architecture. The architecture, ADR discipline, and phase completeness are all in good shape.

---

## Gate 2 — Intra-phase Remediation: PASS addendum (2026-06-17)

All six items from §4 executed and verified:

| Item | What was done | Status |
|------|--------------|--------|
| B7 — Frontend test vacuum | Stood up Vitest + @solidjs/testing-library + happy-dom; 3 test files, 16 tests covering `sindri.ui` binding surface: ExtHostClient dispatch/listen/treeView/quickPick/decorations (host.test.ts), QuickPick store state machine (quick-pick-store.test.ts), TreeViewHost chrome render (tree-view-host.test.tsx) | ✅ 16/16 passed |
| B6 — Heavy inline test modules | Split `lib.rs` (926 lines) into `lib.rs` (thin bootstrap) + `resource.rs` + `ext_cmds.rs` + `dev_cmds.rs`; extracted `exthost/mod.rs` inline tests → `exthost/tests.rs`; extracted `runtime.rs` `mod inspector_tests` → `exthost/runtime_tests.rs` (with `#[path]` redirect) | ✅ |
| B9 — Fallible unwraps | `tmp_bundle.to_str().ok_or_else(…)?` in `ext_cmds.rs`; `.expect("static content-type header …")` documenting invariant in `resource.rs` | ✅ |
| B10 — Dead svelte devDeps | Removed `svelte@^4.2.20`, `esbuild-svelte@^0.9.5`, `svelte-preprocess@^5.1.4` from `package.json` | ✅ |
| B3 — Static inline styles | Added `.settings-btn-secondary--compact`, `.settings-subsection-title--spaced` modifier classes and `margin-top` to `.ext-active-empty` in `styles.css`; replaced all 4 static `style=` attributes in `SettingsModal.tsx` | ✅ |
| Re-verification | `cargo test --workspace`: **32 passed, 0 failed** (19 sindri + 13 sindri-core/lib); `bun run test`: **16 passed, 0 failed**; `bun run typecheck`: **clean** | ✅ |

**Verdict: `PASS` — Gate 2 complete. Phase 2 may begin.**

---

# Phase 1 §1.6 Closure Review — second pass (2026-06-17)

> **Why a second review.** The first pass (above) PASSED Phase 1 and spawned two **non-gating** §1.6 follow-ups: (1) god-file decomposition, (2) the API-version gate. Both were since reported **done** (HANDOVER: ADR-0040 + five decompositions). This pass **reviews that remediation** — did the work the first review spawned actually land as claimed, and does the enlarged file set introduce new smells — before Phase 1 is declared truly closed and Phase 2 begins. **Reviewer model:** Opus 4.8.
>
> **One-line verdict:** **`BLOCKED` → a small, mostly-mechanical must-fix.** ADR-0040 is excellent and the frontend decompositions landed cleanly, **but the §1.6 `runtime.rs` decomposition was reported complete and is not** — the file is still **1231 lines (2× the 🔴 split threshold)** with a ~490-line embedded JS asset un-extracted, and two HANDOVER claims are factually wrong.

## Verification gate (re-run this pass)

| Check | Result |
|---|---|
| `cargo test --workspace` | ✅ **43 passed · 1 ignored · 0 failed** (sindri_lib 19 · sindri-cli 3 · sindri_core 21; +1 ignored doctest) |
| `bun run test` (Vitest) | ✅ **16/16** — the frontend splits did not break the Gate-2 suite |
| `bun run typecheck` | ✅ clean |
| `unsafe` / hardcoded paths | ✅ **0 / 0** |
| `engines.sindri` on extensions | ✅ **58/58** declare it |
| `@sindri/api` version vs `HOST_API_VERSION` | ✅ both **0.1.0** |

> **Note — the "21/21" scare was mine, not the code's.** A first `cargo test … | tail -40` truncated the per-binary results; the full run is 43+1. No test regression from the decomposition.

## Findings

### Axis B — Engineering & Architecture Health

| # | Finding | Tag | Disposition |
|---|---|---|---|
| **R-1** | **`exthost/runtime.rs` decomposition is incomplete despite being reported done.** §1.6 extracted `ops.rs`/`source_map.rs`/`polyfills.rs`/tests, but `runtime.rs` is **still 1231 lines** — 2× the 🔴 `split > 600` threshold. Lines **48–540 are a ~490-line embedded `SINDRI_BOOTSTRAP` JS string** (B2 explicitly says extract such assets via `include_str!`); the seven `do_*` dispatch handlers (809–1211, ~400 lines) are a cohesive cluster that belongs in its own module. The file is genuinely single-subsystem, so this is *unfinished extraction*, not a tangle — but it was claimed finished. | 🔴 | **must-fix** — extract `SINDRI_BOOTSTRAP` → `.js` via `include_str!` (drops file to ~740) + move `do_*` handlers → `exthost/dispatch.rs` (→ ~340). Mechanical. |
| **R-2** | **ADR-0040 activation gate has no integration test.** `semver.rs` carries a thorough `check_engine` matrix (absent/wildcard/floor/caret-0.x/tilde/too-old/too-new/malformed), but **nothing asserts `ExtHost::activate()` actually returns `IncompatibleHost` before V8 allocation** — the pure function is proven, the wiring is not. The gate logic *is* wired ([mod.rs:80–94](../../src-tauri/src/exthost/mod.rs#L80)) and the `ext_check_compat` Compat→JSON mapping exists, so risk is low; the proof is missing. | 🟡 | **must-fix (cheap)** — one `#[tokio::test]` activating with an incompatible `engines` range, asserting `Err(IncompatibleHost)`. |
| **R-3** | **SettingsModal split produced a near-god child.** `ActiveExtensionSection.tsx` = **493** (just under 🔴 500, well into 🟡 > 300) and marketplace `store.ts` = **460** — the decomposition relocated bloat into one large child rather than fully resolving it. Separately, **`lib/tauri.ts` = 552 (🔴 > 500)** remains untouched (it was a first-pass 🟡-future, not a §1.6 named target). | 🟡 | future-roadmap (engineering-hardening slot) — not gating. |
| **R-4** | **`B9` clean** — the only non-test/non-lock unwraps are documented-invariant `.expect()`s (`resource.rs`, runtime bootstrap) and a provably-ASCII base64 encoder (`inspector_gateway.rs:369`). `ext_cmds.rs:147/251` are multi-line mutex `.lock().unwrap()` (accepted class). No regression from the split. | 🟢 | accept |

### Axis A — Vision & Decision Integrity

| # | Finding | Tag | Disposition |
|---|---|---|---|
| **R-5** | **ADR-0040 is exemplary.** It documents the range syntax, the activation-hard-gate / install-soft-warn split, the directionality model (`HostTooOld`/`HostTooNew`/`BadRange`), **and explicitly records the deviation from the planned `semver` crate** (hand-rolled `VersionReq`, with a `Supersedes` note on the HANDOVER's "add semver crate" line). The named scope deviation is a *recorded decision, not drift*. | 🟢 | accept |
| **R-6** | **HANDOVER doc-truth errors.** (a) §1.6 table claims `runtime.rs` is **"835 lines"** after the split — it is **1231**. (b) Current-state claims **`cargo test → 21/21`** — actual is **43 passed + 1 ignored** (21 is just the `sindri_core` binary; the claim halves the real suite). | 🟡 | **must-fix (trivial)** — correct both before they mislead the next session. |
| **R-7** | **1 ignored doctest** in `sindri_lib` (a ```` ```ignore ```` doc fence, not a disabled behavior test). No `#[ignore]` in source. | 🟢 | accept (note) |

### Axis C — Phase Completeness

The first pass's C1 reconstruction stands; §1.6 closed the one ruinous-to-retrofit seam it flagged (C2-apiver → ADR-0040), and the gate is wired end-to-end (activate hard-block + install warn + `ext_check_compat`) with extensions adopting `engines.sindri` repo-wide. **No new completeness gaps** introduced by the remediation. The remaining open seams (crash/dispose discipline, state-persistence) remain correctly parked at Phase 7.

## ADR amendment proposals

> **Empty.** No earlier ADR is invalidated by the §1.6 work. ADR-0040 is internally consistent and correctly supersedes the stale "add semver crate" note. The decomposition is a pure refactor and touches no locked decision.

## Remediation plan

### 🔴 Intra-phase remediation — **HARD GATE** (finish what §1.6 claimed, then Phase 2)

> **Model: 🔻 Sonnet 4.6** — all three items are mechanical. Do not spend Opus here.

1. **Finish `runtime.rs` (R-1):** extract `SINDRI_BOOTSTRAP` → `exthost/bootstrap.js` loaded via `include_str!`; move the `do_*` dispatch handlers → `exthost/dispatch.rs`. Target `runtime.rs` < 400. Re-run `cargo test --workspace`.
2. **Add the ADR-0040 activation-gate test (R-2):** one `#[tokio::test]` asserting `activate()` → `Err(IncompatibleHost)` on an incompatible range.
3. **Fix HANDOVER doc-truth (R-6):** correct the `runtime.rs` line count and the test-count claim.

### 🟡/🟢 Future-roadmap insertions

| Item | Target | Source |
|---|---|---|
| Decompose `lib/tauri.ts` (552 🔴) + `ActiveExtensionSection.tsx` (493) + marketplace `store.ts` (460) | §1.6 engineering-hardening (non-gating; tackle when those surfaces are next extended) | R-3 |

## Verdict & gate status

| | |
|---|---|
| **Gate 1 — Review (§1.6 closure)** | ✅ Complete (Axes A/B/C re-run against the remediation) |
| **Gate 2 — Intra-phase remediation** | 🔴 **Outstanding** (3-item must-fix above) |
| **Verdict** | **`BLOCKED`** — §1.6's `runtime.rs` decomposition was reported done but left the file at 2× the hard-split threshold with its largest asset un-extracted; two doc claims are false. All cheap/mechanical to clear. |
| **Path to PASS** | Execute the 3-item must-fix on **Sonnet**, re-run `cargo test --workspace` + `bun run test` + typecheck green, then append a PASS addendum. **Phase 2 may not begin until then.** |

> **Severity call (user may rebalance).** `runtime.rs` is genuinely cohesive and **not** on Phase 2's critical path (tree-sitter adds a new binding + CM6 bridge; it doesn't extend `runtime.rs`), so a case exists for `PASS-WITH-FOLLOWUPS` instead. It is gated here on a narrower principle: a remediation item the project **reported complete** must actually be complete before the phase closes — otherwise the §1.6 ledger is dishonest. The fix is ~30–45 min of mechanical work; cheaper to finish than to carry as a false "done."

---

## §1.6 Closure — Gate 2 PASS addendum (2026-06-17)

All three must-fix items executed and verified:

| Item | What was done | Status |
|------|--------------|--------|
| R-1 — `runtime.rs` extraction | Extracted `SINDRI_BOOTSTRAP` (~490 lines JS) → `exthost/bootstrap.js` loaded via `include_str!`; moved `do_*` dispatch handlers + V8 helpers → new `exthost/dispatch.rs` (`pub(crate)`, declared in `exthost/mod.rs`). `runtime.rs`: **1231 → 356 lines** ✅ (🟢 target range). `dispatch.rs`: 392 lines (🟢). `bootstrap.js`: 486 lines (not a Rust file). | ✅ |
| R-2 — ADR-0040 activation gate test | Added `engine_gate_blocks_incompatible_extension` `#[tokio::test]` to `exthost/tests.rs`: calls `host.activate()` with `engines: Some(">99.0.0")`, asserts `Err(IncompatibleHost)`. The gate fires before V8 allocates an isolate. | ✅ |
| R-6 — HANDOVER doc-truth | Corrected line count (1231, not "835") and test count (44 passed + 1 ignored, not "21/21"). | ✅ |
| Re-verification | `cargo test --workspace`: **44 passed · 1 ignored · 0 failed** (sindri_lib 20 · sindri-cli 3 · sindri_core 21); `bun run test`: **16/16**; `bun run typecheck`: clean. | ✅ |

**Verdict: `PASS` — Phase 1 fully closed. Phase 2 may begin.**
</content>
</invoke>
