# ADR-0008: Workspace model — loose files + projects coexist in one window

- Status: Accepted
- Date: 2026-06-01
- Extended by: [ADR-0013](0013-product-identity-and-polyglot-thesis.md)

## Context

We are "text-editor first, workspace second." Users must be able to open individual loose files quickly (Sublime-style), *and* open richer "projects" defined by a project file in a folder — and crucially, **both must coexist in the same window at once**. This is unlike VSCode's tendency to treat a window as one folder/workspace.

The founding polyglot directive (ADR-0013) sharpens this further: multi-language projects are the **primary** case. A single project root may carry multiple toolchains (e.g. a Rust core + a TypeScript frontend). The workspace model must accommodate this without treating it as an edge case.

## Decision

A window holds a **session** containing a flat set of **roots**, where a root is either:

- a **loose file** — opened directly, no folder context; or
- a **project** — a folder containing a Sindri project file (`sindri.toml`) that declares its identity, run/test configs, and settings.

Loose files and projects live side by side in the same session/window. Editor intelligence (LSP, search scope, run configs) resolves per the owning root: a loose file gets best-effort single-file support; a file inside a project gets that project's full context. The project manifest (`sindri.toml`) is the unit that the built-in frameworks (ADR-0005) and extensions key off of.

## Consequences

- The buffer/session state model must treat "open document" and "workspace root" as separate, loosely-coupled concepts — a document may or may not belong to a project root.
- LSP/DAP/search must be scoped per-root, and the UI must make clear which context a given file resolves under.
- The Sindri project-file format (`sindri.toml`) is designed in [ADR-0012](0012-project-file-format.md). v0 can open loose files only and treat a plain folder as an implicit project.
- This is a deliberate point of difference from VSCode and a usability bet for the polyglot user who has a script and a project open together.
- A project root may declare multiple toolchains in `sindri.toml` (ADR-0012). The UI must surface which toolchain context a given file resolves under when more than one is active.
