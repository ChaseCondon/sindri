//! `sindri ext …` — the extension release engine (ADR-0033 §5/§7).
//!
//! Phase 1/2: pure-Rust commands `changed`, `plan`/`status`, `bump`, `validate`.
//! Phase 3: `build` (bun esbuild fork + Rust `.sinxt` packaging) and `release`
//! (gh release create). CI/bots are thin callers; every command supports `--json`.

mod build;
mod gh;
mod version;
mod watch;

pub use build::{build, build_index, release, BuildExtResult};
pub use version::{bump, changed, plan, validate, ChangedExt, ExtPlan};
pub use watch::watch;
