//! `sindri-core` — shared truth for the Sindri app and the `sindri` CLI.
//!
//! Per ADR-0033 §2 this crate carries the manifest types, `.sinxt` model,
//! path resolution, and semver logic used by **both** the Tauri app and the
//! CLI. It links **neither Tauri nor V8**, so the CLI stays lean and
//! `cargo install`-able while the app reuses the exact same definitions.

pub mod captures;
pub mod manifest;
pub mod pack;
pub mod paths;
pub mod semver;

/// Sindri host API version — the version of the extension-host contract implemented
/// by this build. Extensions declare `engines.sindri` ranges against this (ADR-0040).
pub const HOST_API_VERSION: &str = "0.1.0";

pub use captures::capture_to_token;
pub use manifest::{validate, validate_paths, Engines, GrammarEntry, Manifest, ValidationIssue, VALID_CATEGORIES};
pub use pack::{collect_package_files, pack_sinxt};
pub use paths::{app_cache_dir, app_data_dir, app_log_dir, extension_dev_dir, extension_install_dir, IDENTIFIER};
pub use semver::{check_engine, level_for_commit, level_for_commits, BumpLevel, Compat, Version};
