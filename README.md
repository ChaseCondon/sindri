# Sindri

> A human-first, language-agnostic IDE — lightweight like an editor, capable like a full IDE.

Sindri is what [Fleet](https://www.jetbrains.com/fleet/) was meant to be: a fast, beautiful, language-agnostic development environment with first-class built-in tooling (test runners, run/job configs, debugging) that feels native for *every* language — not a text editor that you bolt extensions onto until it resembles an IDE.

## Principles

1. **Human-first, not AI-native.** The product is built for a developer in the driver's seat. AI is an optional, secondary assistant — never the center of gravity. See [ADR-0002](docs/adr/0002-human-first-not-ai-native.md).
2. **Performance is a feature.** Native-feeling responsiveness. Custom GPU-accelerated text rendering on a web UI. See [ADR-0003](docs/adr/0003-gpu-editor-surface.md).
3. **Batteries included, language-agnostic.** Test runner, run configs, task/job runner, and debugging are built-in frameworks driven by per-language adapters (LSP / DAP / the Sindri Adapter Protocol) — not 12 competing extensions. See [ADR-0005](docs/adr/0005-builtin-ide-frameworks.md).
4. **Extensible from day one.** A stable plugin API ships with v0. See [ADR-0006](docs/adr/0006-extension-api-from-day-one.md).

## Stack

- **Shell:** [Tauri 2](https://tauri.app/) — Rust core, web frontend, small footprint.
- **Frontend:** TypeScript + [SolidJS](https://www.solidjs.com/) for IDE chrome.
- **Editor surface:** [CodeMirror 6](https://codemirror.net/) (DOM) for interactive editing, plus a tiered **WebGL2** glyph-atlas overlay for big-file scroll / minimap. See [ADR-0003](docs/adr/0003-editor-surface-cm6-plus-webgl2.md).
- **Language support:** Tree-sitter + LSP + DAP, hosted by the Rust core. Language-agnostic by being a great protocol host, not by writing per-language code.
- **Build:** Vite + pnpm workspace.

> **Note on speed:** Tauri gets us Zed-class *startup & memory*, but DOM/webview editing latency is in VSCode's tier, not Zed's. The pitch is "fast like a native app, unlike Electron." Big-file scroll is where we actively beat the DOM incumbents. See [ADR-0001](docs/adr/0001-shell-tauri.md).

See [docs/design/vision.md](docs/design/vision.md) for the full picture and [docs/adr/](docs/adr/) for the decision record.

## Status

🚧 Pre-alpha. Bootstrapping the walking skeleton.

## Develop

```sh
bun install
bun run dev        # Vite dev server (web UI only)
bun run tauri dev  # full app window (requires platform webview deps — see docs/development.md)
```
