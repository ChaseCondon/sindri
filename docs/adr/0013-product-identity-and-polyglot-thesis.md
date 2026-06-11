# ADR-0013: Product identity (Sindri) and polyglot-first founding thesis

- Status: Accepted
- Date: 2026-06-02
- Strengthens: [ADR-0008](0008-workspace-model.md), [ADR-0006](0006-extension-api-from-day-one.md)

## Context

Two product-thesis decisions were deferred from the initial ADR set and require a permanent record: the product name (replacing the "Forge" working placeholder) and the explicit articulation of the polyglot founding premise that all subsequent architecture assumes.

The name question was straightforward — "Forge" is saturated in developer tooling and does not distinguish the product. A meaningful name was needed.

The polyglot question has architectural teeth: it is not enough to say "we support multiple languages." The original ADR-0008 framed the workspace model as "loose files and projects coexist," which is true but undersells the commitment. The full premise is that multi-language projects are the **primary** use case, not an extension of a single-language default.

## Decision

### Product name: Sindri

The product is named **Sindri** (Norse mythology: the master dwarf-smith who forged Mjölnir, Draupnir, and Gullinbursti — artifacts of the highest craft). The name was chosen for:

- Authentic Norse origin, matching the project's aesthetic direction.
- Direct semantic link to craft, mastery, and creation — the right connotations for an IDE.
- Clean English readability (`SIN-dree`) without forcing a pronunciation guess.
- Low collision in developer tooling namespaces.

**Logo direction:** a single stylized **Sowilō ᛋ** (Elder Futhark sun-rune). The rune's angular zig-zag reads naturally as an S; its straight-cut strokes (runes were carved, not drawn) produce a strong, geometric mark suited to a monospace/IDE context. **Important: use a single rune only** — two Sowilō side by side (ᛋᛋ) carries historical association with the SS insignia and must not appear in any form.

**Namespace:** all first-party extensions and adapters use the `sindri.*` prefix (e.g. `sindri.lang.rust`, `sindri.adapter.cargo`). The project manifest file is `sindri.toml`; the local-state directory is `.sindri/`.

### Polyglot-first as the founding premise

The product is built around multi-language projects as the **default case**. This is a stronger commitment than ADR-0008's "loose files + projects coexist" framing — it means:

1. **The UI is designed for multiple first-class language contexts in one window.** Run/test panels, environment scoping, status indicators, and navigation all assume that a single open project may have two or more active toolchains (e.g. a Rust core + a TypeScript frontend). Single-language is a degenerate case of this, not the other way around.

2. **The wedge is the JetBrains gap.** A Tauri project (Rust core + web frontend) currently forces a choice between RustRover, WebStorm, using both simultaneously, or a sub-par VSCode extension assembly. Sindri is the answer to that specific pain: one IDE, one window, first-class features for every language the project uses.

### Everything is an extension, including first-party features

This strengthens ADR-0006's dogfooding rule to its logical conclusion. It is not sufficient that first-party features *could* be built on the extension API — they **must** be, and this is a hard constraint. Wrappers, adapters, runners, language packs, run/test panels: all ship as extensions consuming the same public API and event bus available to third parties. No private shortcuts.

**Day-one bundled extensions** (shipped with Sindri, implemented as extensions on the public API):

| Extension ID | Contents |
|---|---|
| `sindri.lang.rust` | rust-analyzer (LSP) · CodeLLDB (DAP) · tree-sitter-rust · `sindri.adapter.cargo` |
| `sindri.lang.java` | Eclipse JDT LS (LSP) · java-debug (DAP) · tree-sitter-java · `sindri.adapter.maven` · `sindri.adapter.gradle` |
| `sindri.lang.python` | pylsp / basedpyright (LSP) · debugpy (DAP) · tree-sitter-python · `sindri.adapter.pytest` · `sindri.adapter.uv` |
| `sindri.lang.web` | vtsls + eslint-lsp (LSP) · js-debug (DAP) · tree-sitter-tsx · `sindri.adapter.npm` · `sindri.adapter.vitest` |

Each language pack bundles the Tree-sitter grammar, LSP server, DAP adapter, and run/test adapters for that ecosystem. Installing one language pack gives complete first-class coverage for that language.

### North star: Sindri builds Sindri

The ultimate dogfood test — and the clearest proof of the polyglot-first thesis — is that Sindri's own codebase (a Tauri project: Rust core in `src-tauri/` + SolidJS/TypeScript frontend in `src/`) is developed entirely within Sindri, without reaching for another IDE. When that is true, the polyglot promise is real.

## Consequences

- ADR-0008's "workspace model" framing is extended: the session can hold multiple project roots, each potentially multi-language. The UI must surface toolchain context clearly when a file could be associated with more than one active toolchain.
- The "everything is an extension" constraint means the internal extension API must be expressive enough to implement run/test/debug panels, language intelligence, and the project manifest format. These cannot be papered over with private channels.
- Day-one bundled extensions ship four language ecosystems: Rust, Java, Python, JavaScript/TypeScript. Additional languages are community-authored extensions on the same public API — depth before breadth, but the path is open from day one.
- The Sindri Adapter Protocol (SAP) — the interface that run/test adapters must implement — is a required near-term spike (currently open, see ADR-0005 and ADR-0012 consequences). The language pack table above assumes SAP is defined.
- The north-star constraint ("Sindri builds Sindri") should be evaluated at each milestone: can the walking skeleton be usably developed in itself? If not, what is the specific missing feature?
