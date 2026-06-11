# ADR-0012: Project-file format — `sindri.toml`

- Status: Accepted
- Date: 2026-06-02
- Extends: [ADR-0008](0008-workspace-model.md), [ADR-0009](0009-remote-execution-environments.md), [ADR-0005](0005-builtin-ide-frameworks.md)

## Context

ADR-0008 deferred the design of the project-file format to its own spike. ADR-0009 added the requirement that it also express execution environments and host↔target path maps. ADR-0005 requires it to carry run/test adapter bindings. ADR-0013 adds the founding polyglot directive: the format must be designed around multi-language projects as the default case, not single-language projects with multi-language bolted on.

The format must answer five questions:

1. What is this project (identity)?
2. Where does it run (execution environments)?
3. How does it run and test (toolchain adapter bindings)?
4. What are its settings and extension dependencies?
5. How is machine-local or user-local state separated from team-shared state?

## Decision

### Serialization: TOML

TOML is the serialization format. It is native in the Rust core (`serde` + `toml`), supports inline comments (unlike JSON), has no significant-whitespace footguns (unlike YAML), and its named-table syntax maps cleanly onto the keyed sections in the schema (`[environments.<name>]`, `[toolchains.<name>]`, etc.). It is also the dominant format for Rust project files (`Cargo.toml`, `pyproject.toml`), which makes it immediately familiar to the polyglot audience Sindri targets.

### File name and location: `sindri.toml` at project root

The committed project file is `sindri.toml`, placed at the root of the project directory. Its presence is the project-detection marker — a folder containing `sindri.toml` is a Sindri project; a folder without one is an implicit project (see below). Placing the manifest at the root follows the convention of every major project-definition tool (`Cargo.toml`, `pyproject.toml`, `package.json`, `deno.json`) and keeps it visible and diff-friendly.

### Three-way state split

Three categories of state are kept physically separate:

| State | Location | Committed? | Format | Purpose |
|-------|----------|:---:|---|---|
| **Project** | `sindri.toml` | ✅ | TOML | Identity, envs, toolchains, run/test overrides, settings, extension deps. Team-shared. |
| **User-local override** | `.sindri/local.toml` | ❌ | TOML | Per-developer overrides deep-merged over `sindri.toml`. Active env, personal flags, local paths. |
| **Session / layout** | `.sindri/session.json` | ❌ | JSON | Window, panel positions, open tabs (ADR-0010). Never merges into config; UI-restore only. |

Sindri auto-writes `.sindri/.gitignore` covering the whole `.sindri/` directory on first use. Session state uses JSON (machine-written, high-churn, no human-editing intent); the two human-edited files use TOML.

**Merge rule for `local.toml`:** deep-merge over `sindri.toml` — tables merge recursively, scalars override, arrays replace (no surprise concatenation). Named tables (`[run.<name>]`, `[toolchains.<name>]`) allow overriding a single entry without touching the rest.

### Versioning: `version = "1"` at root

A root `version` scalar carries the schema major version. Sindri refuses to open a file with a higher major than it understands (clear error message). Within a known major, Sindri tolerates unknown keys — additive forward-compatibility. When a breaking schema change is needed, a new major is issued.

### No-manifest behavior: implicit projects

A plain folder with no `sindri.toml` is an implicit project:
- Identity: folder name, ephemeral runtime id (hash of absolute path).
- Environment: `local` only (ADR-0009: remote is a project-root property).
- No run/test configs, no settings overrides.
- "Convert to Sindri project" writes a minimal `sindri.toml` and generates a stable UUIDv4 id.

### `id` generation timing

A stable `id` is only needed once project identity is shared (i.e., committed). The id is a UUIDv4 generated and written into `[project].id` on the first action that persists project identity — "Convert to Sindri project" or the first write of a project-scoped setting. Until then, the path-hash ephemeral id is sufficient for machine-local session state. Sindri never writes `sindri.toml` just to mint an id.

### Run/test: adapter-first

All run and test execution goes through a **Sindri Adapter Protocol** (SAP) adapter. Raw shell commands are not a first-class concept in `sindri.toml`; they are available only via the built-in `shell` adapter, keeping Sindri in control of all execution (structured output, consistent UI, env-scoped spawning per ADR-0009).

`[toolchains.<name>]` binds an adapter to the project in an environment. The adapter **auto-discovers** run targets and test suites from the toolchain's own metadata (e.g. `cargo metadata`, effective POM, `package.json` scripts) — manual `[run]`/`[test]` entries are optional overrides or additions. This is the mechanism that makes zero-config first-class: open a Cargo project and run configs appear automatically.

### Path maps

A `host`/`target` pair in `[[environments.<name>.paths]]` defines the bidirectional mapping between a host path and a path inside the environment. Sindri translates in whichever direction is needed; no `direction` field is required. Multiple pairs are supported for projects that mount more than one path (e.g. a sibling repo volume). When no `paths` block is present, sensible defaults apply: `/workspace` for containers, `\\wsl$\<distro>\…` for WSL, the configured remote home for SSH.

## Schema

The full schema for `sindri.toml`:

**Root:** `version` (string, required)

**`[project]`** — identity
- `name` — string, required
- `id` — UUIDv4 string, written on first persist of identity
- `description` — string, optional
- `default_environment` — string, optional; falls back to `"local"` if omitted

**`[environments.<name>]`** — execution targets (ADR-0009)
- `type` — `"local"` | `"wsl"` | `"container"` | `"ssh"`, required
- `distro` — string (wsl)
- `image` — string (container, image mode)
- `compose` — string (container, compose-file path)
- `service` — string (container, compose service name)
- `host` — string (ssh)
- `user` — string (ssh, optional)
- `[[environments.<name>.paths]]` — array of `{ host, target }` pairs

**`[toolchains.<name>]`** — adapter bindings; auto-discover run + test configs
- `adapter` — SAP adapter id (e.g. `sindri.adapter.cargo`), required
- `environment` — string, optional; falls back to `default_environment`

**`[run.<name>]`** — optional run-config overrides/additions
- `toolchain` — string (references a `[toolchains.<name>]`), or `adapter` directly
- `task` — adapter verb (e.g. `"run"`, `"spring-boot:run"`), or omit for auto
- `args` — string array
- `cwd` — string, project-relative, resolved inside the environment
- `env` — inline table of `string → string`

**`[test.<name>]`** — optional test-suite overrides/additions
- `toolchain` — string (references a `[toolchains.<name>]`), or `adapter` directly
- `environment` — string, optional
- `include` — string array of discovery globs
- `exclude` — string array

**`[settings.<group>]`** — nested project-scoped settings (e.g. `[settings.editor]`, `[settings.search]`)

**`[extensions]`** — required extension/adapter dependencies
- `"<extension-id>"` = `"<semver-range>"` (e.g. `"sindri.lang.rust" = "*"`)

## Consequences

- The adapter-first run/test model means the **Sindri Adapter Protocol** must be specified (deferred spike, see open threads). The project-file format is stable without it — `[toolchains]` entries reference adapter IDs, and the SAP spec defines what those adapters must implement.
- Language packs (e.g. `sindri.lang.rust`) bundle Tree-sitter grammar + LSP server + DAP adapter as an extension. They are declared in `[extensions]` and require no per-language wiring in `sindri.toml` itself.
- The polyglot case (multiple languages in one project) is first-class: add one `[toolchains.<name>]` entry per language; each can point to a different environment. No limit on toolchain count per project.
- `local.toml` enables per-developer environment switching (e.g. a team member with a fast local Rust toolchain skips the container while CI always uses it) without touching committed config.
- Session state (`session.json`) being in JSON and never merged into config keeps ADR-0010 layout state fully decoupled from project identity — the two can evolve independently.

## See also

- [ADR-0013](0013-product-identity-and-polyglot-thesis.md) — product name + polyglot-first founding directives
- [docs/examples/sindri.toml](../examples/sindri.toml) — annotated polyglot example manifest
