//! `sindri-core` — shared truth for the Sindri app and the `sindri` CLI.
//!
//! Per ADR-0033 §2 this crate carries the manifest types, `.sinxt` model,
//! path resolution, and semver logic used by **both** the Tauri app and the
//! CLI. It links **neither Tauri nor V8**, so the CLI stays lean and
//! `cargo install`-able while the app reuses the exact same definitions.

pub mod manifest;
pub mod pack;
pub mod paths;
pub mod semver;

pub use manifest::{validate, validate_paths, Manifest, ValidationIssue, VALID_CATEGORIES};
pub use pack::{collect_package_files, pack_sinxt};
pub use paths::{app_cache_dir, app_data_dir, app_log_dir, extension_dev_dir, extension_install_dir, IDENTIFIER};
pub use semver::{level_for_commit, level_for_commits, BumpLevel, Version};
