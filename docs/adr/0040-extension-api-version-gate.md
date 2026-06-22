# ADR-0040 — Extension API-version gate (`engines.sindri`)

**Status:** Accepted — 2026-06-17

**Supersedes:** The "add semver crate" line in the [HANDOVER.md](../../HANDOVER.md) prior session note — we implemented the check inline without a semver crate dependency.

---

## Context

Extensions run inside the Sindri extension host. As the host API evolves, an extension compiled against a newer API surface may call ops that don't exist yet on the user's installed version, producing cryptic JS errors at activate time. Conversely, an extension that deliberately targets an older range shouldn't silently break on a newer host.

VS Code addresses this with `engines.vscode: "^1.75.0"` in `package.json`. Sindri already reserves `engines.sindri` in the manifest JSON schema (the `validate()` function flags its absence as an error) but previously ignored its value at runtime.

---

## Decision

### 1. Range syntax — npm-compatible subset

`engines.sindri` accepts an **npm-compatible semver range subset**:

| Syntax | Meaning |
|--------|---------|
| `>=1.0.0` / `>1.0.0` / `<=1.0.0` / `<1.0.0` | explicit comparator |
| `=1.0.0` or bare `1.0.0` | exact match |
| `^1.2.3` | `>=1.2.3 <2.0.0` (or `<0.2.0` / `<0.0.2` for 0.x / 0.0.x) |
| `~1.2.3` | `>=1.2.3 <1.3.0` |
| `*` or empty string | always passes |
| space-separated | all comparators must hold (`>=1.0.0 <2.0.0`) |

No external crate needed — the full subset is implemented in `sindri_core::semver::VersionReq` (≈ 80 lines).

### 2. Host API version constant

`sindri_core::HOST_API_VERSION = "0.1.0"` — the canonical host contract version. Bumped when the extension-host API surface changes in a breaking way. Lives in `sindri-core` so both the Tauri app and the CLI can read it without linking Tauri.

### 3. Where the check runs

**Activation (hard gate):** `ExtHost::activate()` in `exthost/mod.rs` calls `check_engine(engines, HOST_API_VERSION)` **before** allocating a V8 isolate. A failing check returns `ExthostError::IncompatibleHost` — the extension does not activate.

**Install-time (soft warning):** The marketplace `doInstall()` flow calls the `ext_check_compat` Tauri command before downloading a `.sinxt` bundle and logs a `console.warn` if the check returns `ok: false`. The install proceeds regardless — the user is warned rather than blocked, because they may be installing for future use or testing.

### 4. Directionality

`check_engine` returns one of:

| Variant | Meaning | Message direction |
|---------|---------|-------------------|
| `Compat::Ok` | host satisfies the range | — |
| `Compat::HostTooOld { required, host }` | range has a lower bound the host doesn't reach | "upgrade Sindri" |
| `Compat::HostTooNew { required, host }` | range has an upper bound the host exceeds | "extension may need an update" |
| `Compat::BadRange(msg)` | `engines.sindri` is not a parseable range | treat as hard fault |

Direction is determined from the **first failing comparator**: lower-bound operators (`>=`, `>`) → HostTooOld; upper-bound (`<=`, `<`) → HostTooNew; exact match failure → compare host vs required version.

### 5. Typed Rust model

```rust
// sindri-core/src/manifest.rs
pub struct Engines { pub sindri: Option<String> }
// added to Manifest: pub engines: Option<Engines>

// sindri-core/src/semver.rs
pub enum Compat { Ok, HostTooOld { required, host }, HostTooNew { required, host }, BadRange(String) }
pub fn check_engine(range: Option<&str>, host: &str) -> Compat

// sindri-core/src/lib.rs
pub const HOST_API_VERSION: &str = "0.1.0";
// re-exports: Compat, check_engine, HOST_API_VERSION, Engines
```

### 6. `engines.sindri` for current extensions

All existing extensions in `sindri-extensions/` should declare `"engines": { "sindri": ">=0.1.0" }`. The manifest validator already rejects manifests without `engines.sindri`, so any extension passing validation already has the field; the runtime gate now actually enforces it.

---

## Consequences

- **Activation hard-blocks** on incompatible extensions — clearer error than a JS crash inside activate().
- **Install only warns** — least-surprise for devs cross-installing or bundling for future hosts.
- **No external semver crate** — the inline implementation covers the needed subset; avoids dependency bloat in `sindri-core` (which must stay lean for `cargo install`).
- **`HOST_API_VERSION` must be bumped deliberately** — breaking host API changes now have a named constant to update and a test surface (unit tests in semver.rs verify range logic).
- `engines.sindri = None` on a typed `Manifest` is still valid (the validate() check is at the JSON level and remains stricter than the typed struct, so CLI validation continues to reject absent fields while internal Rust paths that don't go through validation can accept them safely).
