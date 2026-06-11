# ADR-0007: Rendering API — WebGL2 baseline, WebGPU only as enhancement

- Status: Accepted
- Date: 2026-06-01

## Context

The tiered GPU overlay (ADR-0003) needs a graphics API. "WebGPU now ships in all major browsers" is misleading for us: **Tauri uses system webviews, not browsers**, and they track different codebases.

Webview-by-webview status (what actually matters for Tauri):

- **Windows / WebView2 (Chromium)** — WebGPU available (since Chromium 113, April 2023).
- **macOS / WKWebView (WebKit)** — WebGPU available, but only on **macOS 26+** (Safari 26). macOS 15 and earlier: no.
- **Linux / WebKitGTK** — WebGPU effectively **unavailable and not on the near roadmap**. Safari's WebGPU is built on Metal, which doesn't exist on Linux; the GTK port would need its own Vulkan backend that maintainers have said isn't supported.

**WebGL2 runs in all three webviews today, no caveats.**

How much WebGPU actually buys a text renderer: a glyph-atlas renderer is close to WebGL2's best case. It's a 2D workload — rasterize glyphs once on CPU, then per frame draw at most a few thousand instanced textured quads, collapsing to ~one instanced draw call. WebGPU's real advantages (compute shaders, low per-draw overhead at tens of thousands of draws, storage buffers, WGSL ergonomics) don't apply: we already batch to ~one draw, and we'll be CPU-bound on glyph shaping/measuring/atlas eviction long before the render API shows up in a profile. This is why xterm.js's WebGL renderer is already buttery without WebGPU.

## Decision

Build the real GPU renderer on **WebGL2** and treat it as **the product, not a fallback**. Hide the backend behind a thin interface (`uploadAtlas` / `drawGlyphInstances` etc.) so the rest of the editor doesn't know which API is live.

Add a **WebGPU backend later only as progressive enhancement** on platforms that have it (Windows, macOS 26+), with automatic fallback to WebGL2 — and only to unlock *new compute-driven capabilities*, never as a prerequisite for the editor to feel fast.

## Consequences

- Full platform coverage including Linux (our likely-heaviest audience) and older macOS, for ~zero performance loss on the scroll workload.
- The only thing genuinely WebGL2-can't-do is compute. Future compute-driven niceties (GPU SDF glyph generation for buttery zoom, GPU-driven minimap over enormous files, GPU fuzzy search, local inference) are exactly what a later WebGPU backend would add — none are core to "scroll a big file smoothly."
- If we ever want full WebGPU semantics (compute included) with complete Linux/macOS coverage, the route is **native Rust `wgpu`** (Tier-3 native surface, ADR-0003), not webview WebGPU — that awkward middle fragments platforms for a workload that doesn't benefit. We skip the middle.
