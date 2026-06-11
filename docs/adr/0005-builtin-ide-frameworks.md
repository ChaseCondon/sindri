# ADR-0005: Built-in IDE frameworks via protocols + adapters (Sindri)

- Status: Accepted
- Date: 2026-06-01

## Context

The product's wedge (with performance) is JetBrains-grade *built-in* run/test/debug/search UX that works identically across languages — the thing VSCode fragments across competing extensions, Zed keeps minimal, and Fleet abandoned. The naive way to get "native feel per language" is JetBrains' way: a bespoke engine per language. That's powerful and heavy and not lightweight. We need language-agnosticism at editor weight.

The insight: **you don't achieve language-agnosticism by writing language support; you achieve it by being an excellent host for standard protocols and tools**, with a single consistent UI shell built once.

## Decision

Be a first-class host for:

- **Tree-sitter** — syntax highlighting and structural understanding (incremental parsing). Non-negotiable. Hosted in Rust.
- **LSP** — completion, diagnostics, go-to-def, rename, hover. We orchestrate language-server processes; language teams write the servers. (Rust: `async-lsp` / `tower-lsp` + `lsp-types`.)
- **DAP** — debugging, via the same decoupling as LSP. This is how we get pretty debuggers across languages without per-language debug logic.
- **ripgrep / `grep-searcher` + `grep-regex`** — content search.
- A small **Sindri Adapter Protocol** for run/test/task — a manifest + thin executable per toolchain (cargo, npm, pytest, go test, …) that tells Sindri how to discover tests, run them, parse results, and surface run configs.

The **UI for all of these is built once in Sindri** and is identical regardless of language. A language "just works" when its LSP server, DAP adapter, Tree-sitter grammar, and Sindri adapter manifest are present.

## Consequences

- Most required pieces (LSP servers, DAP adapters, Tree-sitter grammars) already exist in the ecosystem — we host, we don't author.
- **Honest gap:** there is no industry-standard *test* protocol the way LSP/DAP exist. Closest prior art is VSCode's Testing API (a generic test-explorer tree populated per-language). So "gorgeous test runners everywhere" includes real bespoke per-ecosystem work for the adapter manifests. We plan for this rather than be surprised by it.
- Depth before breadth: each milestone takes **one** language/toolchain end-to-end before generalizing.
- Polish is product work, not a stack property — no framework hands us JetBrains-grade panels. The stack choice (web UI, ADR-0001/0004) is what makes building them *fast*.
