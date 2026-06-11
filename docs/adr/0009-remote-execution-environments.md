# ADR-0009: Remote execution environments (WSL / containers / SSH) from day one

- Status: Accepted
- Date: 2026-06-01
- Extends: [ADR-0008](0008-workspace-model.md)

## Context

Modern dev rarely happens purely on the host: code builds, runs, tests, and language servers increasingly live in **WSL distros, containers, or remote SSH hosts**, while the editor UI runs locally. VSCode bolted this on later (Remote-SSH/WSL/Dev Containers) as heavyweight extensions, and the seams show. We want it to be a **first-class, day-one concept**, declared **in the project file** so a project carries its own environment definition.

The deeper architectural point: if "where files live" and "where commands execute" are assumed to be the local host anywhere in the core, retrofitting remote support means rewriting that core. So even before we *implement* remote backends, the core must be built against an **environment abstraction**.

## Decision

1. **The project manifest declares its execution environment(s).** A project file can specify a target like `local`, `wsl: <distro>`, `container: <image|compose service>`, or `ssh: <host>`, plus how to map paths between host and target.
2. **The Rust core is written against an `Environment` trait from day one** — an abstraction over: file IO + watching, process spawning, and port/stream forwarding. `LocalEnvironment` is the only implementation in v0; WSL/container/SSH are additional implementations behind the same trait.
3. **All toolchain interaction goes through the active environment.** LSP servers, DAP adapters, the Sindri run/test adapters (ADR-0005), search, and tasks spawn *in the project's environment*, not on the host. The editor UI and CM6 buffers always stay local; only execution and filesystem access are environment-scoped.
4. Loose files (ADR-0008) are always `local`. Remote is a property of a *project root*.

## Consequences

- This is the single most invasive constraint on the core's design: file and process APIs in Rust must be environment-parameterized from the first commit, even while only `local` exists. Cheap to honor now, very expensive to retrofit.
- Path translation (host ↔ target) and stream/port forwarding are real subsystems we'll need; we scope them when the first non-local backend lands, but the trait reserves the seam.
- Order of implementation: `local` (v0) → WSL (cheapest second backend on Windows) → containers → SSH. Each is "just another `Environment`."
- The project-file format (ADR-0008's deferred spike) must now also express environment targets and path maps from its first version.
