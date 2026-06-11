# Sindri — Vision & Architecture

> Status: living document. Last updated 2026-06-01.

## 1. The bet

Every editor on the market is sprinting toward "agentic." Sindri bets the other way: **the human is the protagonist.** Developers still want to read, understand, and write code themselves — they want a tool that makes *them* faster, not one that tries to replace the act of thinking. AI may join later as a quiet assistant, but it is never the headline and never the default mode.

The second bet: **Fleet had the right idea and the wrong execution.** A lightweight, language-agnostic environment that still *feels* like a purpose-built IDE for whatever language you open is a real, unmet niche. VSCode is a text editor that becomes an IDE only after you assemble a pile of extensions (and pray they agree with each other). JetBrains IDEs feel native but are heavy, per-language, and expensive. Sindri wants JetBrains polish at editor weight, for any language, out of the box.

**The third bet, and the founding premise: polyglot projects are the primary case, not an edge case.** The JetBrains gap is sharpest for the full-stack developer: a Tauri project forces a choice between RustRover, WebStorm, using both, or assembling a sub-par VSCode extension stack. Sindri is built ground-up for projects that span multiple languages simultaneously — the UI, run/test surfaces, environment scoping, and project model all assume several first-class toolchains coexisting in one window. Single-language is a degenerate case of this, not the starting point.

**The north star: Sindri builds Sindri.** Sindri's own codebase — a Tauri project with a Rust core and a TypeScript/SolidJS frontend — is developed entirely within Sindri, without reaching for another IDE. This is the proof of the polyglot promise and the ultimate dogfood test. See also [ADR-0013](../adr/0013-product-identity-and-polyglot-thesis.md).

## 2. Who it's for

- Polyglot developers who switch languages within a day and resent re-learning a different extension stack for each.
- People who loved Sublime/Zed's speed but missed real run/test/debug UX.
- People who found JetBrains too heavy or too siloed per language.
- People actively tired of AI being shoved into every panel.

## 3. The wedge (why switch)

A great editor that's *also* free and excellent already exists twice over. Sindri wins on the combination of:

1. **Performance** — startup, keystroke latency, large-file handling, search. Non-negotiable.
2. **Built-in IDE frameworks** — a real, consistent, beautiful UI for running, testing, and debugging that works identically across languages. This is the thing neither VSCode (fragmented) nor Zed (minimal) nor Fleet (abandoned) nails.

Performance alone moves no one. Performance + "it just has a proper test runner / debugger / run configs for my language with zero setup" is a reason to switch.

## 4. Architecture (high level)

```
┌─────────────────────────────────────────────────────────────┐
│  Web UI (TypeScript / SolidJS)                               │
│  ┌───────────────┐  ┌──────────────────────────────────────┐ │
│  │  IDE chrome   │  │  Editor surface                      │ │
│  │  (DOM/Solid)  │  │  CodeMirror 6 (DOM, editing) +       │ │
│  │  panels, tabs │  │  WebGL2 overlay (scroll / minimap)   │ │
│  └───────────────┘  └──────────────────────────────────────┘ │
│         │  Tauri IPC (commands + events)                      │
├─────────┼───────────────────────────────────────────────────┤
│  Rust core (src-tauri)                                        │
│  ┌────────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ FS / git / │ │ ripgrep   │ │ LSP host │ │ DAP host     │  │
│  │ watch      │ │ search    │ │ (lang)   │ │ (debug)      │  │
│  └────────────┘ └───────────┘ └──────────┘ └──────────────┘  │
│  ┌──────────────────────────┐ ┌──────────────────────────┐   │
│  │ Test/Run/Task adapters   │ │ Extension host (JS / RPC) │   │
│  └──────────────────────────┘ └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Division of labor**
- **Rust core** owns anything that touches the OS or must stay fast at scale: file IO, git, file watching, workspace indexing, content search (ripgrep / `grep-searcher`), and the protocol hosts (LSP, DAP, test/task adapters, extension host). It is the source of truth for *files on disk* and for *external processes*.
- **Web UI** owns presentation and interaction. The IDE chrome (sidebars, panels, tabs, command palette, run/test/debug UIs) is ordinary DOM via SolidJS. The **editor surface is CodeMirror 6** — the DOM-based editing surface that hands us selection, IME/dead-key composition, accessibility, native find, and copy/paste *for free*. CM6 owns the live document model (its own rope) for open buffers; we do **not** mirror a canonical rope in Rust, because syncing two ropes over IPC is complexity we don't need at v0.
- **The GPU play is tiered, not total.** We do not replace the DOM editor with a from-scratch GPU grid — that re-earns all the freebies above by hand and is most of the work of going fully native. Instead we add a **WebGL2** glyph-atlas overlay for the cases the DOM is genuinely bad at: fast/fling scrolling, the minimap/overview ruler, and very large or read-only files. We switch the surface to it past a size/velocity threshold and switch back for interactive editing. WebGL2 (not WebGPU) because it's the only option that works across all three Tauri webviews — see [ADR-0007](../adr/0007-webgl2-not-webgpu.md).
- **IPC** is the seam. Keep it coarse and explicit (Tauri commands + events). CM6 changes route to Rust for persistence and to drive LSP `didChange`; Rust pushes diagnostics, search results, and process output back as events.

**Honest performance framing.** This stack gives **Zed-class startup and idle memory** (no bundled Chromium) but **VSCode-class keystroke latency** (both are DOM/webview pipelines; Zed's ~2ms comes from painting glyphs straight to the GPU, which a webview can't match for the *interactive* surface). So the pitch is "fast like a native app, unlike Electron" — *not* "fast like Zed." The place we credibly beat the DOM incumbents is **big-file scroll**, via the tiered renderer, plus Tier-0 DOM hygiene (fixed line-height, aggressive viewport virtualization, async tree-sitter that never blocks a scroll frame). On Linux specifically, WebKitGTK's editing surface can feel *worse* than VSCode's tuned Chromium — the tiered GPU scroll path is partly how we claw that back.

## 5. Language-agnostic, the lightweight way

JetBrains achieves "native feel" with a bespoke engine per language — powerful, heavy. Sindri achieves it with **protocols + a consistent UI shell**:

- **Editing/intelligence** → [LSP](https://microsoft.github.io/language-server-protocol/) (completions, diagnostics, go-to-def, rename, hover).
- **Debugging** → [DAP](https://microsoft.github.io/debug-adapter-protocol/).
- **Syntax** → Tree-sitter grammars.
- **Running / testing / tasks** → a small **Sindri Adapter Protocol** we define: a manifest + thin executable that tells Sindri how to discover tests, run them, parse results, and surface run configurations for a given toolchain (cargo, npm, pytest, go test, …). **Honest gap:** unlike LSP/DAP there is *no* industry-standard test protocol. The closest prior art is VSCode's Testing API — a generic test-explorer tree that per-language adapters populate. So "gorgeous test runners for every language" is partly bespoke per-ecosystem work; we plan for it rather than discover it in month four.

The UI for all of these is built **once** in Sindri and is identical regardless of language. A language "just works" when its LSP server, DAP adapter, Tree-sitter grammar, and Sindri adapter manifest are present — most of which already exist in the ecosystem.

## 6. Everything is an extension, including first-party features

"Extensible from day one" (ADR-0006) is taken to its logical conclusion: every wrapper, adapter, runner, language pack, and IDE panel ships as an extension on the same public API available to third parties. No private shortcuts. No features that quietly depend on internal channels the extension API cannot express.

**Day-one bundled language packs** (each is an extension implementing the public API):

- `sindri.lang.rust` — rust-analyzer + CodeLLDB + tree-sitter-rust + cargo adapter
- `sindri.lang.java` — Eclipse JDT LS + java-debug + tree-sitter-java + maven/gradle adapters
- `sindri.lang.python` — pylsp/basedpyright + debugpy + tree-sitter-python + pytest/uv adapters
- `sindri.lang.web` — vtsls + eslint-lsp + js-debug + tree-sitter-tsx + npm/vitest adapters

The practical consequence: the extension API is not "done" until Sindri's own run/test/debug panels are built on it. Shipping day-one language packs as real extensions is the forcing function that makes the API real.

## 7. Non-goals (for now)

- Being a general-purpose Electron-style app platform.
- AI agents as a primary workflow.
- 100% VSCode extension API compatibility (we'll have our own, cleaner API; a compat shim is a maybe-later).
- *Implementing* remote/WSL/container/SSH backends in v0 — but the **environment abstraction they plug into is day-one** ([ADR-0009](../adr/0009-remote-execution-environments.md)). v0 ships only the `local` backend; the seam is reserved so remote is additive, not a rewrite.

## 8. Roadmap sketch

- **v0 — Walking skeleton:** window opens, open a file, edit it, save it. Editor surface rendering text. Proves Tauri↔Rust↔GPU loop. *(current)*
- **v0.1 — Real editing:** CodeMirror 6 integration (multi-cursor, undo/redo), Tree-sitter highlighting, file tree, command palette, save-to-disk via Rust.
- **v0.2 — Intelligence:** LSP host (one language end-to-end, e.g. Rust or TypeScript).
- **v0.3 — Built-in frameworks:** run configs + test runner UI via the Sindri Adapter Protocol (one toolchain end-to-end).
- **v0.4 — Debugging:** DAP host + debugger UI.
- **v0.5 — Plugins:** stable extension API, sample plugin.

Each milestone takes one language/toolchain end-to-end before generalizing — depth before breadth.

### Day-one architectural seams (build correctly even if minimally implemented — these cannot be retrofitted)

Some decisions are cheap to honor now and ruinous to retrofit, so their *abstractions* land from the first commits even though their full feature surface arrives later:

- **`Environment` trait** ([ADR-0009](../adr/0009-remote-execution-environments.md)) — all file IO and process spawning in the Rust core go through it; only `local` is implemented in v0, WSL/container/SSH are later impls.
- **Dock/layout model + tool-window registration** ([ADR-0010](../adr/0010-dockable-panel-layout.md)) — v0 may ship a fixed two-sidebar + bottom-dock layout, but panels register through the contribution API so free movement and floating windows are additive.
- **Provider interfaces over the public extension API** ([ADR-0006](../adr/0006-extension-api-from-day-one.md)) — including the `InlineCompletionProvider` ([ADR-0011](../adr/0011-inline-completion-and-suggestions.md)), so the one day-one AI is a pluggable provider, not a core dependency.
