# ADR-0003: Editor surface — CodeMirror 6 + tiered WebGL2 overlay

- Status: Accepted
- Date: 2026-06-01

## Context

The editor surface is where responsiveness and large-file performance are won or lost. Options span a ladder:

- **Tier 0 — DOM, optimized.** Fixed line-height, aggressive viewport virtualization, async highlighting that never blocks a scroll frame. Cheap, high reward, but a max-velocity scroll on a huge file can still stutter.
- **Tier 1 — Canvas 2D.** Paint lines with `fillText`; no per-line DOM. Faster scroll, but glyphs still rasterize on CPU and you lose DOM-native selection/IME/find/a11y.
- **Tier 2 — WebGL2/WebGPU glyph atlas.** Rasterize each glyph once into a GPU texture atlas, draw visible text as instanced quads. This *is* a GPU text renderer, hosted in the webview — same architecture as alacritty/wezterm/xterm.js. Matches native scroll smoothness on huge files.
- **Tier 3 — Native wgpu surface composited into the webview.** Zed-grade, but you hand-build a cross-platform compositor and the reasons to use Tauri evaporate.

The catch at every tier above 0: the DOM gives us multi-line selection, IME/dead-key composition (CJK, accents — catastrophic if done wrong), accessibility/screen-readers, native find, spellcheck, copy/paste fidelity, and complex-script/RTL shaping **for free**. Painting text ourselves re-earns all of it by hand. This is exactly why Monaco and CodeMirror 6 stayed on the DOM despite the scroll ceiling — they chose correctness-for-free over peak scroll FPS.

Editor-core choice: **CodeMirror 6 over Monaco.** Monaco is heavyweight and VSCode-coupled; making it "lite" fights the grain. CM6 is modular, fast, and designed for composition — we pull in only what we need, and it owns its own document model (rope) for open buffers.

## Decision

**Interactive editing runs on CodeMirror 6 (DOM).** We do Tier-0 DOM hygiene thoroughly as the baseline.

We add a **WebGL2 glyph-atlas renderer (Tier 2)** as a *tiered overlay* — not a replacement — for the cases the DOM is genuinely bad at: fast/fling scrolling, the minimap/overview ruler, and very large or read-only files. We switch the visible surface to the GPU path past a size/velocity threshold and switch back to CM6 for interactive editing, so users get DOM correctness where they type and GPU smoothness where they fling.

CM6 owns the canonical live document for open buffers. We do **not** mirror a rope in Rust (see vision doc §4).

## Consequences

- We get DOM correctness (selection, IME, a11y, find) where it matters and a credible big-file-scroll story — the one axis where we can out-render VSCode.
- We avoid re-implementing text input/selection/IME for the whole editor, which is most of the cost of going native.
- Cost: a tiered renderer is two code paths plus the threshold/switching logic and keeping the GPU overlay visually consistent with CM6 (fonts, themes, ligatures).
- The GPU backend hides behind a thin interface (`uploadAtlas`, `drawGlyphInstances`) so the renderer API (WebGL2 vs future WebGPU, ADR-0007) is swappable.
- **Hard rule:** tree-sitter highlighting is never synchronous with a scroll frame. Render known/stale tokens immediately, reparse async in Rust, reconcile.

## Alternatives considered (editor core)

| Option | Verdict | Why |
|--------|---------|-----|
| **Monaco** (VSCode's editor) | ✗ | Most batteries-included, but heavyweight, large bundle, VSCode-coupled, and architected *to be VSCode*. Making it "lite" and deeply re-skinnable fights the grain. Its ~decade of DOM tuning may even edge CM6 on raw latency — but weight + coupling lose for a lean, custom editor. |
| **Ace** | ✗ | Mature but architecturally dated, less modular, weaker TS story, fading momentum. |
| **Raw / from-scratch** (DOM or canvas) | ✗ | Re-earns selection, IME, undo, multi-cursor, search, accessibility — the exact freebies argument above, an enormous surface. Only justified if the *editing surface is the product's soul*, and then the answer is native/fork (ADR-0001), not raw-in-webview. |
| **CodeMirror 6** | ✓ | The sweet spot: small composable core (pull only what you need), extension-first architecture, rope document model, strong IME/a11y/mobile, MIT. Its composability mirrors our own "build features as extensions / dogfood" philosophy (ADR-0006). |

> **Known integration nuance — Lezer vs Tree-sitter.** CM6 ships its own incremental parser (**Lezer**) and grammars; our language-agnostic bet (ADR-0005) leans on **Tree-sitter** in the Rust core, where far more grammars exist. These don't automatically align. We resolve it by treating the Rust Tree-sitter layer as the structural source of truth and bridging highlight spans into CM6 (decorations), rather than relying on per-language Lezer grammars for breadth. Lezer may still serve where a quality grammar already exists. Flagged now so it's a design choice, not a month-four surprise.
