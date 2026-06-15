//! The `sindri` CLI — `code`-equivalent launcher + extension release engine.
//!
//! ADR-0033. Phase 1/2: `doctor`, `ext changed`/`plan`/`bump`/`validate`.
//! Phase 3: `ext build` (bun esbuild fork + Rust .sinxt packaging) and
//! `ext release` (gh release create). The launcher (`sindri .`) and authoring
//! (`ext new`/`dev`) are reserved for later phases. Every machine-facing
//! command supports `--json` + meaningful exit codes for Actions / bots.

mod doctor;
mod ext;
mod git;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "sindri",
    version,
    about = "The Sindri CLI — launcher + extension release engine (ADR-0033)."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Diagnose the local toolchain and show resolved data directories.
    Doctor {
        #[arg(long)]
        json: bool,
    },
    /// Extension release-engine and authoring commands.
    Ext {
        #[command(subcommand)]
        command: ExtCommand,
    },
}

/// Common options for the git-backed release-engine commands.
#[derive(clap::Args)]
struct RangeArgs {
    /// Compare against this git ref (e.g. `origin/main`, a tag, or a SHA).
    #[arg(long, default_value = "origin/main")]
    since: String,
    /// Extensions repo root. Defaults to the current directory.
    #[arg(long)]
    repo: Option<PathBuf>,
    /// Emit machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Subcommand)]
enum ExtCommand {
    /// List extensions changed since a ref (exit 1 when none changed).
    Changed {
        #[command(flatten)]
        range: RangeArgs,
    },
    /// Show the release plan (inferred bump + next version + changelog).
    #[command(alias = "status")]
    Plan {
        #[command(flatten)]
        range: RangeArgs,
    },
    /// Bump changed extensions' versions; dry-run unless `--apply`.
    Bump {
        #[command(flatten)]
        range: RangeArgs,
        /// Write manifest.json + CHANGELOG.md instead of a dry run.
        #[arg(long)]
        apply: bool,
    },
    /// Validate an extension's manifest.json (structure + declared paths).
    Validate {
        /// Path to the extension directory.
        path: String,
        #[arg(long)]
        json: bool,
    },
    /// Build an extension's JS bundle and optionally package a .sinxt archive.
    Build {
        /// Path to the extension directory.
        path: String,
        /// Also produce a .sinxt archive after the JS bundle step.
        #[arg(long)]
        bundle: bool,
        /// Embed source maps inline (data URL) instead of generating a separate .map file.
        /// Use for dev/hot-reload builds so V8 Inspector can show original .ts sources.
        #[arg(long)]
        dev_sourcemaps: bool,
        /// Path to a checked-out sindri-ide (overrides SINDRI_IDE_ROOT env).
        #[arg(long)]
        ide_root: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Build and publish GitHub Releases for all untagged, buildable extensions.
    Release {
        /// Extensions repo root. Defaults to the current directory.
        #[arg(long)]
        repo: Option<PathBuf>,
        /// Path to a checked-out sindri-ide (overrides SINDRI_IDE_ROOT env).
        #[arg(long)]
        ide_root: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Regenerate index.json from all manifest.json files in the repo.
    BuildIndex {
        /// Extensions repo root. Defaults to the current directory.
        #[arg(long)]
        repo: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Watch source files for changes, rebuild, and copy output for hot-reload.
    Watch {
        /// Path to the extension directory.
        path: String,
        /// Path to a checked-out sindri-ide (overrides SINDRI_IDE_ROOT env).
        #[arg(long)]
        ide_root: Option<PathBuf>,
        /// Source-poll interval in milliseconds.
        #[arg(long, default_value = "500")]
        interval_ms: u64,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Doctor { json } => doctor::run(json),
        Command::Ext { command } => match command {
            ExtCommand::Changed { range } => ext::changed(range.repo, &range.since, range.json),
            ExtCommand::Plan { range } => ext::plan(range.repo, &range.since, range.json),
            ExtCommand::Bump { range, apply } => {
                ext::bump(range.repo, &range.since, apply, range.json)
            }
            ExtCommand::Validate { path, json } => ext::validate(&path, json),
            ExtCommand::Build { path, bundle, dev_sourcemaps, ide_root, json } => {
                ext::build(&path, bundle, dev_sourcemaps, ide_root.as_deref(), json)
            }
            ExtCommand::Release { repo, ide_root, json } => {
                ext::release(repo, ide_root, json)
            }
            ExtCommand::BuildIndex { repo, json } => ext::build_index(repo, json),
            ExtCommand::Watch { path, ide_root, interval_ms } => {
                ext::watch(&path, ide_root.as_deref(), interval_ms)
            }
        },
    };

    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
