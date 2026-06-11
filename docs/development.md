# Development setup

## Prerequisites

- **Rust** (stable) + Cargo — [rustup.rs](https://rustup.rs)
- **[Bun](https://bun.sh)** 1.1+ — our package manager and script runner
- **Tauri CLI** — provided via the `tauri` dev dependency; run it with `bun run tauri ...`

## Running

```sh
bun install

# Frontend only, in your browser (no native window, no Rust):
bun run dev          # http://localhost:1420

# Full app window (Rust core + native webview):
bun run tauri dev
```

`bun run dev` runs just the Vite frontend and works anywhere — useful for fast UI iteration. When Sindri runs outside the Tauri shell, filesystem commands fall back to in-memory/no-op stubs (see `src/lib/tauri.ts`).

## Platform notes

### Linux / WSL2 (important)

Tauri's Linux webview is **WebKitGTK**, which is a system dependency you must install, plus `pkg-config` and build tooling. On Debian/Ubuntu:

```sh
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential curl wget file \
  libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  pkg-config
```

On **WSL2** specifically, opening a native window also requires **WSLg** (ships with recent WSL; run `wsl --update` from Windows). Without it, `bun run tauri dev` will build but have no display to render into. For pure UI work, prefer `bun run dev` in a browser.

> **Producing a Windows-native build:** cross-compiling a Tauri `.exe`/`.msi` from inside WSL is *not* the supported path (it needs the MSVC toolchain + WebView2 plumbing that doesn't cross-compile cleanly). To ship a Windows binary, install Rust + Bun on **Windows** and run `bun run tauri build` there against this same repo. WSL/WSLg is for the *Linux* dev loop; Windows artifacts come from Windows.

> Heads up (see [ADR-0001](adr/0001-shell-tauri.md)): WebKitGTK is the slowest/quirkiest of the three platform webviews. The tiered WebGL2 scroll path ([ADR-0003](adr/0003-editor-surface-cm6-plus-webgl2.md)) is part of how we keep Linux feeling good.

### Icons

`bun run tauri dev`/`build` expect app icons under `src-tauri/icons/`. Generate them once from a source PNG with:

```sh
bun run tauri icon path/to/logo.png
```

## Layout

```
docs/            vision + ADRs (read docs/design/vision.md first)
src/             SolidJS frontend (IDE chrome + CM6 editor surface)
src-tauri/       Rust core (Tauri commands, FS, future LSP/DAP hosts)
```
