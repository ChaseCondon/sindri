//! `sindri ext …` — the extension release engine (ADR-0033 §5/§7).
//!
//! Phase 1/2: pure-Rust commands `changed`, `plan`/`status`, `bump`, `validate`.
//! Phase 3: `build` (bun esbuild fork + Rust `.sinxt` packaging) and `release`
//! (gh release create). CI/bots are thin callers; every command supports `--json`.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use sindri_core::semver::{BumpLevel, Version};

use crate::git;

/// A changed extension and the facts a workflow gates on.
#[derive(Debug, Serialize)]
pub struct ChangedExt {
    pub id: String,
    /// Directory relative to the repo root (the top-level path segment).
    pub dir: String,
    pub buildable: bool,
    pub files: Vec<String>,
}

/// One extension's release plan: inferred bump + resulting version + changelog.
#[derive(Debug, Serialize)]
pub struct ExtPlan {
    pub id: String,
    pub dir: String,
    pub buildable: bool,
    pub current_version: String,
    pub bump: BumpLevel,
    /// `"conventional-commits"` when a commit drove the level, else
    /// `"default-patch"` (the dir changed but no conv-commit signal was found).
    pub bump_source: &'static str,
    pub next_version: String,
    pub already_tagged: bool,
    /// Commit subjects (first lines) destined for the CHANGELOG section.
    pub changelog: Vec<String>,
}

/// Resolve the repo root: an explicit `--repo`, else the current directory.
fn repo_root(repo: Option<PathBuf>) -> Result<PathBuf> {
    let root = match repo {
        Some(p) => p,
        None => std::env::current_dir().context("cannot read current directory")?,
    };
    if !git::is_git_repo(&root) {
        bail!("{} is not inside a git work tree", root.display());
    }
    Ok(root)
}

fn read_manifest(dir: &Path) -> Result<sindri_core::Manifest> {
    let p = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&p)
        .with_context(|| format!("cannot read {}", p.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("invalid manifest at {}", p.display()))
}

/// Map changed files to the extension directories that contain them, mirroring
/// `pr-check.yml`: take each file's top-level path segment and keep it if
/// `<repo>/<seg>/manifest.json` exists. Order-preserving, deduplicated.
fn changed_exts(repo: &Path, since: &str) -> Result<Vec<ChangedExt>> {
    let files = git::changed_files(repo, since)?;
    let mut out: Vec<ChangedExt> = Vec::new();

    for f in &files {
        let Some(seg) = f.split('/').next() else { continue };
        if seg.is_empty() {
            continue;
        }
        if let Some(existing) = out.iter_mut().find(|e| e.dir == seg) {
            existing.files.push(f.clone());
            continue;
        }
        let dir = repo.join(seg);
        if !dir.join("manifest.json").is_file() {
            continue;
        }
        let manifest = read_manifest(&dir)?;
        out.push(ChangedExt {
            id: manifest.id,
            dir: seg.to_string(),
            buildable: manifest.buildable != Some(false),
            files: vec![f.clone()],
        });
    }
    Ok(out)
}

fn plan_for(repo: &Path, since: &str, changed: &ChangedExt) -> Result<ExtPlan> {
    let dir = repo.join(&changed.dir);
    let manifest = read_manifest(&dir)?;
    let current = Version::parse(&manifest.version)
        .with_context(|| format!("{} has non-semver version {}", changed.id, manifest.version))?;

    let messages = git::commit_messages(repo, since, &changed.dir)?;
    let inferred = sindri_core::level_for_commits(messages.iter().map(String::as_str));
    let (bump, bump_source) = if inferred == BumpLevel::None {
        (BumpLevel::Patch, "default-patch")
    } else {
        (inferred, "conventional-commits")
    };

    let changelog: Vec<String> = messages
        .iter()
        .filter_map(|m| m.lines().next())
        .map(|s| s.trim().to_string())
        .collect();

    Ok(ExtPlan {
        id: manifest.id.clone(),
        dir: changed.dir.clone(),
        buildable: manifest.buildable != Some(false),
        current_version: current.to_string(),
        bump,
        bump_source,
        next_version: current.bump(bump).to_string(),
        already_tagged: git::tag_exists(repo, &manifest.release_tag())?,
        changelog,
    })
}

// ── command entrypoints ───────────────────────────────────────────────────────

pub fn changed(repo: Option<PathBuf>, since: &str, json: bool) -> Result<i32> {
    let root = repo_root(repo)?;
    let exts = changed_exts(&root, since)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&exts)?);
    } else if exts.is_empty() {
        println!("No changed extensions since {since}.");
    } else {
        println!("Changed extensions since {since}:");
        for e in &exts {
            let flag = if e.buildable { "" } else { "  (buildable: false)" };
            println!("  {} — {} file(s){}", e.id, e.files.len(), flag);
        }
    }
    // Exit non-zero when nothing changed so a workflow can gate cheaply (ADR-0033 §5).
    Ok(if exts.is_empty() { 1 } else { 0 })
}

pub fn plan(repo: Option<PathBuf>, since: &str, json: bool) -> Result<i32> {
    let root = repo_root(repo)?;
    let exts = changed_exts(&root, since)?;
    let plans: Vec<ExtPlan> = exts
        .iter()
        .map(|e| plan_for(&root, since, e))
        .collect::<Result<_>>()?;

    if json {
        println!("{}", serde_json::to_string_pretty(&plans)?);
    } else if plans.is_empty() {
        println!("No changed extensions since {since} — nothing to release.");
    } else {
        for p in &plans {
            let tagged = if p.already_tagged {
                "  ⚠ already tagged"
            } else {
                ""
            };
            println!(
                "{}  {} → {} ({}, {}){}",
                p.id, p.current_version, p.next_version, p.bump, p.bump_source, tagged
            );
            for entry in &p.changelog {
                println!("    • {entry}");
            }
        }
    }
    Ok(0)
}

pub fn bump(repo: Option<PathBuf>, since: &str, apply: bool, json: bool) -> Result<i32> {
    let root = repo_root(repo)?;
    let exts = changed_exts(&root, since)?;
    let plans: Vec<ExtPlan> = exts
        .iter()
        .map(|e| plan_for(&root, since, e))
        .collect::<Result<_>>()?;

    if apply {
        for p in &plans {
            if p.bump == BumpLevel::None {
                continue;
            }
            let dir = root.join(&p.dir);
            write_manifest_version(&dir, &p.next_version)?;
            prepend_changelog(&dir, &p.next_version, &p.changelog)?;
        }
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&plans)?);
    } else if plans.is_empty() {
        println!("No changed extensions since {since} — nothing to bump.");
    } else {
        let verb = if apply { "Bumped" } else { "Would bump" };
        for p in &plans {
            println!("{} {} {} → {}", verb, p.id, p.current_version, p.next_version);
        }
        if !apply {
            println!("\nDry run — re-run with --apply to write manifest.json + CHANGELOG.md.");
        }
    }
    Ok(0)
}

pub fn validate(path: &str, json: bool) -> Result<i32> {
    let dir = PathBuf::from(path);
    let manifest_path = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("no manifest.json at {}", dir.display()))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| format!("invalid JSON in {}", manifest_path.display()))?;

    let mut issues = sindri_core::validate(&value);

    // Path-existence checks only run when the structural manifest is sound.
    let missing: Vec<String> = if issues.is_empty() {
        let manifest: sindri_core::Manifest = serde_json::from_value(value)?;
        sindri_core::validate_paths(&dir, &manifest)
    } else {
        Vec::new()
    };
    for m in &missing {
        issues.push(sindri_core::ValidationIssue {
            field: "(path)".to_string(),
            message: format!("declared file does not exist: {m}"),
        });
    }

    if json {
        #[derive(Serialize)]
        struct Report<'a> {
            ok: bool,
            issues: &'a [sindri_core::ValidationIssue],
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&Report {
                ok: issues.is_empty(),
                issues: &issues,
            })?
        );
    } else if issues.is_empty() {
        println!("✓ {} — manifest valid", path);
    } else {
        eprintln!("✘ {} — manifest validation failed:", path);
        for i in &issues {
            eprintln!("    {}: {}", i.field, i.message);
        }
    }
    Ok(if issues.is_empty() { 0 } else { 1 })
}

// ── file mutation helpers ─────────────────────────────────────────────────────

/// Rewrite only the `"version"` value in `manifest.json`, preserving all other
/// formatting and key order (a serde round-trip would reorder/reformat).
fn write_manifest_version(dir: &Path, next: &str) -> Result<()> {
    let path = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&path)?;
    let mut replaced = false;
    let out: Vec<String> = raw
        .lines()
        .map(|line| {
            if !replaced && line.trim_start().starts_with("\"version\"") {
                if let Some((before_colon, after_colon)) = line.split_once(':') {
                    // Replace the first quoted token after the colon.
                    if let Some(rebuilt) = replace_first_quoted(after_colon, next) {
                        replaced = true;
                        return format!("{before_colon}:{rebuilt}");
                    }
                }
            }
            line.to_string()
        })
        .collect();
    if !replaced {
        bail!("could not locate a \"version\" field in {}", path.display());
    }
    let trailing_newline = if raw.ends_with('\n') { "\n" } else { "" };
    std::fs::write(&path, out.join("\n") + trailing_newline)?;
    Ok(())
}

/// Replace the first `"…"` token in `s` with `"value"`, keeping surrounding text.
fn replace_first_quoted(s: &str, value: &str) -> Option<String> {
    let start = s.find('"')?;
    let end = s[start + 1..].find('"')? + start + 1;
    Some(format!("{}\"{}\"{}", &s[..start], value, &s[end + 1..]))
}

/// Prepend a `## <version> - <date>` section to `CHANGELOG.md`, creating it
/// (with a `# Changelog` title) if absent.
fn prepend_changelog(dir: &Path, version: &str, entries: &[String]) -> Result<()> {
    let path = dir.join("CHANGELOG.md");
    let mut section = format!("## {} - {}\n\n", version, today_ymd());
    if entries.is_empty() {
        section.push_str("- _No changelog entries inferred._\n");
    } else {
        for e in entries {
            section.push_str(&format!("- {e}\n"));
        }
    }

    let new_contents = match std::fs::read_to_string(&path) {
        Ok(existing) => {
            // Keep a leading `# Changelog` title at the top if present.
            if let Some(rest) = existing.strip_prefix("# Changelog\n") {
                format!("# Changelog\n\n{section}\n{}", rest.trim_start_matches('\n'))
            } else {
                format!("{section}\n{existing}")
            }
        }
        Err(_) => format!("# Changelog\n\n{section}"),
    };
    std::fs::write(&path, new_contents)?;
    Ok(())
}

// ── Phase-3: ext build + ext release ─────────────────────────────────────────

/// Result returned by [`build_extension`] for use by `ext release`.
#[derive(Debug, Serialize)]
pub struct BuildExtResult {
    pub extension_js: bool,
    pub webview_js: bool,
    pub sinxt_path: Option<PathBuf>,
}

/// Resolve the `--ide-root` path.  Priority:
///   1. explicit `--ide-root` CLI arg
///   2. `SINDRI_IDE_ROOT` environment variable (CI compatibility)
///   3. `../sindri-ide` sibling of the repo root
fn resolve_ide_root(explicit: Option<&Path>, repo: &Path) -> Result<PathBuf> {
    if let Some(p) = explicit {
        if p.is_dir() {
            return Ok(p.to_path_buf());
        }
        bail!("--ide-root {} does not exist", p.display());
    }
    if let Ok(val) = std::env::var("SINDRI_IDE_ROOT") {
        let p = PathBuf::from(&val);
        if p.is_dir() {
            return Ok(p);
        }
        bail!("SINDRI_IDE_ROOT={val} does not exist");
    }
    // Guess: sibling of the extensions repo root.
    let sibling = repo
        .parent()
        .map(|p| p.join("sindri-ide"))
        .unwrap_or_else(|| PathBuf::from("../sindri-ide"));
    if sibling.is_dir() {
        return Ok(sibling);
    }
    bail!(
        "cannot locate sindri-ide: pass --ide-root <path> or set SINDRI_IDE_ROOT.\n\
         (tried sibling {sibling_display})",
        sibling_display = sibling.display()
    );
}

/// Ensure `packages/sindri-api/dist/helpers.js` is built and up to date.
/// Mirrors the staleness check in `sindri-ide/scripts/build-extension.ts`.
fn ensure_api_built(ide_root: &Path) -> Result<()> {
    let api_dir = ide_root.join("packages/sindri-api");
    let src = api_dir.join("helpers.ts");
    let out = api_dir.join("dist/helpers.js");

    let stale = !out.exists() || {
        let src_mtime = src
            .metadata()
            .with_context(|| format!("cannot stat {}", src.display()))?
            .modified()?;
        let out_mtime = out.metadata()?.modified()?;
        src_mtime > out_mtime
    };

    if stale {
        eprintln!("  building @sindri/api...");
        let status = Command::new("bun")
            .current_dir(&api_dir)
            .args(["run", "build"])
            .status()
            .context("failed to spawn `bun run build` for @sindri/api")?;
        if !status.success() {
            bail!("@sindri/api build failed");
        }
    }
    Ok(())
}

/// Generate a minimal esbuild TypeScript script for a single extension.
///
/// Rust controls all options (entry points, aliases, framework detection) and
/// writes them as JSON-escaped string literals into the script body.  The
/// script is run via `bun run <tmp>` from `ide_root` so it has access to
/// `esbuild` and `esbuild-sass-plugin` in `ide_root/node_modules`.
///
/// This is NOT delegation to a maintained `.ts` file — the script is generated
/// fresh each invocation and deleted afterwards (ADR-0033 §7 constraint).
fn generate_build_script(
    ext_dir: &Path,
    api_helpers: &Path,
    dev_sourcemaps: bool,
) -> String {
    let ext_dir_json = serde_json::to_string(&ext_dir.to_string_lossy().as_ref()).unwrap();
    let api_json = serde_json::to_string(&api_helpers.to_string_lossy().as_ref()).unwrap();
    // "inline" embeds the full source map + original source text as a data URL so
    // V8 Inspector / chrome://inspect can show .ts sources with no file fetching.
    // "linked" produces a separate .map file (used for release builds).
    let ext_sourcemap = if dev_sourcemaps { "inline" } else { "linked" };

    format!(
        r#"// Auto-generated by `sindri ext build` — do not edit; deleted after use.
import * as esbuild from "esbuild";
import {{ sassPlugin }} from "esbuild-sass-plugin";
import * as fs from "fs";
import * as path from "path";

const extDir = {ext_dir_json};
const apiHelpers = {api_json};

const fmtBytes = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+' MB' : n >= 1e3 ? (n/1e3).toFixed(1)+' KB' : n+' B';
const logBuilt = (f) => console.log(`  built  ${{path.basename(f).padEnd(20)}}  ${{fmtBytes(fs.statSync(f).size)}}`);

// ── Extension bundle (IIFE, V8 isolate) ──────────────────────────────────────
const extEntry = path.join(extDir, "src/extension.ts");
if (fs.existsSync(extEntry)) {{
  await esbuild.build({{
    entryPoints: [extEntry],
    bundle: true,
    outfile: path.join(extDir, "dist/extension.js"),
    format: "iife",
    globalName: "sindri_ext",
    platform: "neutral",
    target: "es2020",
    sourcemap: "{ext_sourcemap}",
    sourcesContent: true,
    plugins: [sassPlugin()],
    alias: {{ "@sindri/api/helpers": apiHelpers }},
    logLevel: "warning",
  }});
  logBuilt(path.join(extDir, "dist/extension.js"));
}}

// ── Webview bundle (IIFE, browser) ───────────────────────────────────────────
const webviewCandidates = [
  "src/webview/index.tsx", "src/webview/index.ts", "src/webview.tsx", "src/webview.ts",
].map(f => path.join(extDir, f)).filter(f => fs.existsSync(f));

if (webviewCandidates.length > 0) {{
  const webviewEntry = webviewCandidates[0];
  const webviewOut = path.join(extDir, "dist/webview.js");

  let jsxOpts = {{}};
  let extraPlugins = [];
  const pkgPath = path.join(extDir, "package.json");
  // Also check bun.lock for workspace deps (bun lockfile v1 embeds dep list).
  const bunLock = path.join(extDir, "bun.lock");
  let deps = {{}};
  if (fs.existsSync(pkgPath)) {{
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    deps = {{ ...pkg.dependencies, ...pkg.devDependencies }};
  }} else if (fs.existsSync(bunLock)) {{
    const lock = fs.readFileSync(bunLock, "utf8");
    // Heuristic: scan for known framework package names in the lockfile text.
    if (lock.includes('"svelte"')) deps["svelte"] = "^4";
    if (lock.includes('"react"')) deps["react"] = "^18";
    if (lock.includes('"solid-js"')) deps["solid-js"] = "^1";
    if (lock.includes('"preact"')) deps["preact"] = "^10";
  }}
  if (deps["svelte"]) {{
    const {{ default: sveltePlugin }} = await import("esbuild-svelte");
    const {{ default: preprocess }} = await import("svelte-preprocess");
    extraPlugins.push(sveltePlugin({{ preprocess: preprocess(), compilerOptions: {{ css: "injected" }} }}));
  }} else if (deps["solid-js"]) {{
    jsxOpts = {{ jsx: "automatic", jsxImportSource: "solid-js" }};
  }} else if (deps["react"]) {{
    jsxOpts = {{ jsx: "automatic", jsxImportSource: "react" }};
  }} else if (deps["preact"]) {{
    jsxOpts = {{ jsx: "automatic", jsxImportSource: "preact" }};
  }}

  await esbuild.build({{
    entryPoints: [webviewEntry],
    bundle: true,
    outfile: webviewOut,
    format: "iife",
    platform: "browser",
    target: "es2020",
    sourcemap: "linked",
    plugins: [sassPlugin(), ...extraPlugins],
    alias: {{ "@sindri/api/helpers": apiHelpers }},
    logLevel: "warning",
    ...jsxOpts,
  }});
  logBuilt(webviewOut);
  const webviewCss = webviewOut.replace(/\.js$/, ".css");
  if (fs.existsSync(webviewCss)) logBuilt(webviewCss);
}}
"#,
        ext_sourcemap = ext_sourcemap,
        ext_dir_json = ext_dir_json,
        api_json = api_json,
    )
}

/// Core build logic shared by `ext build` and `ext release`.
///
/// 1. Validates the manifest.
/// 2. Ensures `@sindri/api` is built.
/// 3. Generates + runs an esbuild script for the JS bundle step.
/// 4. If `bundle`, collects files and packs a `.sinxt`.
///
/// Returns details about what was produced.
fn build_extension(ext_dir: &Path, ide_root: &Path, bundle: bool, dev_sourcemaps: bool) -> Result<BuildExtResult> {
    // --- Validate manifest ---------------------------------------------------
    let manifest_path = ext_dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("no manifest.json at {}", ext_dir.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("invalid JSON in {}", manifest_path.display()))?;
    let issues = sindri_core::validate(&value);
    if !issues.is_empty() {
        eprintln!("✘ manifest validation failed ({}):", ext_dir.display());
        for i in &issues {
            eprintln!("    {}: {}", i.field, i.message);
        }
        bail!("manifest validation failed");
    }
    let manifest: sindri_core::Manifest = serde_json::from_value(value)?;

    // --- @sindri/api freshness check ----------------------------------------
    ensure_api_built(ide_root)?;
    let api_helpers = ide_root.join("packages/sindri-api/dist/helpers.js");

    // --- JS bundle step (shell bun esbuild via generated temp script) --------
    let has_ext_entry = ext_dir.join("src/extension.ts").is_file();
    let webview_candidates = [
        "src/webview/index.tsx",
        "src/webview/index.ts",
        "src/webview.tsx",
        "src/webview.ts",
    ]
    .iter()
    .any(|f| ext_dir.join(f).is_file());
    let needs_js = has_ext_entry || webview_candidates;

    if needs_js {
        let script = generate_build_script(ext_dir, &api_helpers, dev_sourcemaps);
        // Write the temp script into ide_root so bun resolves node_modules
        // relative to the script's directory (bun ignores CWD for resolution).
        let tmp = ide_root.join(format!(".sindri_build_{}.ts", std::process::id()));
        std::fs::write(&tmp, &script)
            .with_context(|| format!("cannot write temp build script {}", tmp.display()))?;
        let result = Command::new("bun")
            .current_dir(ide_root)
            .args(["run", tmp.to_str().unwrap()])
            .status();
        let _ = std::fs::remove_file(&tmp);
        let status = result.context("failed to spawn bun for JS bundle step")?;
        if !status.success() {
            bail!("JS bundle step failed for {}", ext_dir.display());
        }
    }

    // --- .sinxt packaging (Rust-native) -------------------------------------
    let sinxt_path = if bundle {
        // Post-build path validation
        let missing = sindri_core::validate_paths(ext_dir, &manifest);
        if !missing.is_empty() {
            eprintln!("✘ manifest references missing files:");
            for m in &missing {
                eprintln!("    {m}");
            }
            bail!("post-build path validation failed");
        }

        let files = sindri_core::collect_package_files(ext_dir, &manifest)?;
        let bytes = sindri_core::pack_sinxt(ext_dir, &files)?;

        let dist = ext_dir.join("dist");
        std::fs::create_dir_all(&dist)?;
        // Remove any previous .sinxt for this extension.
        for entry in std::fs::read_dir(&dist)? {
            let entry = entry?;
            if entry
                .path()
                .extension()
                .is_some_and(|e| e == "sinxt")
            {
                std::fs::remove_file(entry.path())?;
            }
        }

        let out_name = format!("{}-{}.sinxt", manifest.id, manifest.version);
        let out_path = dist.join(&out_name);
        std::fs::write(&out_path, &bytes)?;

        let kb = bytes.len() as f64 / 1_000.0;
        println!(
            "  ✓ dist/{out_name}  ({} files · {kb:.1} KB)",
            files.len()
        );
        Some(out_path)
    } else {
        None
    };

    Ok(BuildExtResult {
        extension_js: has_ext_entry,
        webview_js: webview_candidates,
        sinxt_path,
    })
}

// ── `ext build` entrypoint ────────────────────────────────────────────────────

pub fn build(
    path: &str,
    bundle: bool,
    dev_sourcemaps: bool,
    ide_root_arg: Option<&std::path::Path>,
    json: bool,
) -> Result<i32> {
    let ext_dir = PathBuf::from(path);
    if !ext_dir.join("manifest.json").is_file() {
        bail!("no manifest.json at {path}");
    }

    // For ide_root resolution, use the ext_dir as the "repo" hint.
    let ide_root = resolve_ide_root(ide_root_arg, &ext_dir)?;
    let result = build_extension(&ext_dir, &ide_root, bundle, dev_sourcemaps)?;

    if json {
        #[derive(Serialize)]
        struct Out {
            path: String,
            extension_js: bool,
            webview_js: bool,
            sinxt_path: Option<String>,
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&Out {
                path: path.to_string(),
                extension_js: result.extension_js,
                webview_js: result.webview_js,
                sinxt_path: result
                    .sinxt_path
                    .map(|p| p.to_string_lossy().into_owned()),
            })?
        );
    } else if !result.extension_js && !result.webview_js && result.sinxt_path.is_none() {
        println!("✓ {path} — data-only extension (no JS to bundle)");
        if bundle {
            println!("  .sinxt written");
        }
    }

    Ok(0)
}

// ── `ext release` entrypoint ─────────────────────────────────────────────────

/// A per-extension release outcome for `--json` output.
#[derive(Serialize)]
struct ReleaseOutcome {
    id: String,
    version: String,
    tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

pub fn release(repo: Option<PathBuf>, ide_root_arg: Option<PathBuf>, json: bool) -> Result<i32> {
    let root = repo_root(repo)?;
    let ide_root = resolve_ide_root(ide_root_arg.as_deref(), &root)?;

    // Scan top-level dirs — mirrors create-releases.ts behaviour.
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !entry.path().is_dir() || name_str.starts_with('.') || name_str == "node_modules" {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if manifest_path.is_file() {
            candidates.push(entry.path());
        }
    }
    candidates.sort();

    let mut outcomes: Vec<ReleaseOutcome> = Vec::new();
    let mut released = 0u32;
    let mut failed = 0u32;

    for dir in &candidates {
        let raw = std::fs::read_to_string(dir.join("manifest.json"))?;
        let manifest: sindri_core::Manifest = serde_json::from_str(&raw)?;

        if !manifest.is_buildable() {
            // buildable: false — skip entirely (no release, no error).
            continue;
        }

        let tag = manifest.release_tag();

        if gh_release_exists(&root, &tag) {
            if !json {
                println!("✓ {}@{} already released", manifest.id, manifest.version);
            }
            outcomes.push(ReleaseOutcome {
                id: manifest.id.clone(),
                version: manifest.version.clone(),
                tag: tag.clone(),
                status: Some("skipped"),
                reason: Some("already_tagged"),
            });
            continue;
        }

        if !json {
            println!("\n── Releasing {}@{} ──", manifest.id, manifest.version);
        }

        let build_result = build_extension(dir, &ide_root, true, false);
        let sinxt_path = match build_result {
            Err(e) => {
                eprintln!("✘ Build failed: {} — {e:#}", manifest.id);
                failed += 1;
                outcomes.push(ReleaseOutcome {
                    id: manifest.id.clone(),
                    version: manifest.version.clone(),
                    tag: tag.clone(),
                    status: Some("failed"),
                    reason: Some("build_failed"),
                });
                continue;
            }
            Ok(r) => match r.sinxt_path {
                Some(p) => p,
                None => {
                    eprintln!("✘ No .sinxt produced for {}", manifest.id);
                    failed += 1;
                    outcomes.push(ReleaseOutcome {
                        id: manifest.id.clone(),
                        version: manifest.version.clone(),
                        tag: tag.clone(),
                        status: Some("failed"),
                        reason: Some("no_sinxt"),
                    });
                    continue;
                }
            },
        };

        let is_prerelease = manifest.version.contains('-');
        if let Err(e) = gh_release_create(
            &root,
            &tag,
            &format!("{} v{}", manifest.name, manifest.version),
            &format!("Release of `{}` v{}.", manifest.id, manifest.version),
            &sinxt_path,
            is_prerelease,
        ) {
            eprintln!("✘ Release failed: {} — {e:#}", manifest.id);
            failed += 1;
            outcomes.push(ReleaseOutcome {
                id: manifest.id.clone(),
                version: manifest.version.clone(),
                tag: tag.clone(),
                status: Some("failed"),
                reason: Some("gh_release_failed"),
            });
            continue;
        }

        if !json {
            println!("✓ Released {tag}");
        }
        released += 1;
        outcomes.push(ReleaseOutcome {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            tag: tag.clone(),
            status: Some("released"),
            reason: None,
        });
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&outcomes)?);
    } else {
        println!("\n{released} released, {failed} failed.");
    }

    Ok(if failed > 0 { 1 } else { 0 })
}

// ── `ext build-index` entrypoint ─────────────────────────────────────────────

/// Regenerates `index.json` from individual `manifest.json` files (ADR-0038 §2).
/// Emits a flat `entries: [{id, path, type}]` array — every extension, pack,
/// collection, and template in the registry, each with its authoritative path.
/// Preserves `name`/`description`/`homepage` from the existing `index.json`.
pub fn build_index(repo: Option<PathBuf>, json: bool) -> Result<i32> {
    let root = match repo {
        Some(p) => p,
        None => std::env::current_dir().context("cannot read current directory")?,
    };

    const SKIP: &[&str] = &["node_modules", "dist", "scripts", ".git"];

    // ── Discover all manifest.json files ─────────────────────────────────────
    struct Entry {
        rel_dir: String,
        manifest: sindri_core::Manifest,
    }

    fn find_manifests(dir: &Path, root: &Path, skip: &[&str], out: &mut Vec<Entry>) -> Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if skip.contains(&name_str.as_ref()) { continue; }
            let path = entry.path();
            if path.is_dir() {
                find_manifests(&path, root, skip, out)?;
            } else if name_str == "manifest.json" {
                let raw = std::fs::read_to_string(&path)
                    .with_context(|| format!("cannot read {}", path.display()))?;
                let manifest: sindri_core::Manifest = serde_json::from_str(&raw)
                    .with_context(|| format!("invalid JSON in {}", path.display()))?;
                let rel_dir = path
                    .parent()
                    .map(|p| p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                out.push(Entry { rel_dir, manifest });
            }
        }
        Ok(())
    }

    let mut all: Vec<Entry> = Vec::new();
    find_manifests(&root, &root, SKIP, &mut all)?;

    // ── Determine type for each manifest ─────────────────────────────────────
    // Use the manifest's own `type` field when present; fall back to category inference.
    fn infer_type(m: &sindri_core::Manifest) -> String {
        if let Some(t) = &m.manifest_type {
            return t.clone();
        }
        let is_pack = m.categories.iter().any(|c| c == "Extension Pack");
        let is_base = m.categories.iter().any(|c| c == "Icon Theme Base");
        if is_base { return "template".to_string(); }
        if is_pack {
            if m.pack_kind.as_deref() == Some("theme") { "collection".to_string() }
            else { "pack".to_string() }
        } else {
            "extension".to_string()
        }
    }

    // ── Build the flat entries list ───────────────────────────────────────────
    #[derive(serde::Serialize)]
    struct IndexEntry {
        id: String,
        path: String,
        #[serde(rename = "type")]
        kind: String,
    }

    let mut entries: Vec<IndexEntry> = all
        .iter()
        .map(|e| IndexEntry {
            id: e.manifest.id.clone(),
            path: e.rel_dir.clone(),
            kind: infer_type(&e.manifest),
        })
        .collect();

    // Sort: top-level entries first (collection → pack → extension), then by id.
    // Template entries sort alongside extensions.
    fn type_rank(t: &str) -> u8 {
        match t {
            "collection" => 0,
            "pack"       => 1,
            _            => 2,
        }
    }
    entries.sort_unstable_by(|a, b| {
        type_rank(&a.kind).cmp(&type_rank(&b.kind)).then(a.id.cmp(&b.id))
    });

    // ── Preserve existing registry metadata ───────────────────────────────────
    let index_path = root.join("index.json");
    let (meta_name, meta_description, meta_homepage) = if index_path.is_file() {
        let raw = std::fs::read_to_string(&index_path).unwrap_or_default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            (
                v["name"].as_str().unwrap_or("").to_string(),
                v["description"].as_str().unwrap_or("").to_string(),
                v["homepage"].as_str().unwrap_or("").to_string(),
            )
        } else {
            (String::new(), String::new(), String::new())
        }
    } else {
        (String::new(), String::new(), String::new())
    };

    // ── Write index.json ──────────────────────────────────────────────────────
    #[derive(serde::Serialize)]
    struct Index {
        name: String,
        description: String,
        homepage: String,
        entries: Vec<IndexEntry>,
    }
    let index = Index {
        name: meta_name,
        description: meta_description,
        homepage: meta_homepage,
        entries,
    };
    let out = serde_json::to_string_pretty(&index)? + "\n";
    std::fs::write(&index_path, &out)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&index)?);
    } else {
        let n_collections = index.entries.iter().filter(|e| e.kind == "collection").count();
        let n_packs       = index.entries.iter().filter(|e| e.kind == "pack").count();
        let n_extensions  = index.entries.iter().filter(|e| e.kind == "extension").count();
        let n_templates   = index.entries.iter().filter(|e| e.kind == "template").count();
        println!(
            "✓ index.json — {} entries ({} collections, {} packs, {} extensions, {} templates)",
            index.entries.len(), n_collections, n_packs, n_extensions, n_templates
        );
        for e in &index.entries { println!("  {} {}  ({})", e.kind, e.id, e.path); }
    }

    Ok(0)
}

// ── gh helpers ────────────────────────────────────────────────────────────────

/// Check whether a GitHub Release tag already exists (mirrors `releaseExists`
/// in `create-releases.ts`).
fn gh_release_exists(repo: &Path, tag: &str) -> bool {
    Command::new("gh")
        .current_dir(repo)
        .args(["release", "view", tag])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Create a GitHub Release and attach the `.sinxt` asset.
fn gh_release_create(
    repo: &Path,
    tag: &str,
    title: &str,
    notes: &str,
    asset: &Path,
    prerelease: bool,
) -> Result<()> {
    let mut args = vec![
        "release", "create", tag,
        "--title", title,
        "--notes", notes,
    ];
    if prerelease {
        args.push("--prerelease");
    }
    let asset_str = asset.to_str().context("asset path is not valid UTF-8")?;
    args.push(asset_str);

    let status = Command::new("gh")
        .current_dir(repo)
        .args(&args)
        .status()
        .context("failed to spawn `gh release create`")?;

    if !status.success() {
        bail!("gh release create failed for {tag}");
    }
    Ok(())
}

/// Today's date as `YYYY-MM-DD`, computed from the system clock with the civil
/// calendar algorithm (no chrono dependency — keeps the CLI lean).
fn today_ymd() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's days-from-epoch → (year, month, day) civil conversion.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ── `ext watch` entrypoint ────────────────────────────────────────────────────

/// Watch an extension's source directory, rebuild on changes, and copy the
/// rebuilt bundle to the dev-reload directory so a running Sindri app can pick
/// it up automatically.
///
/// Protocol (mirrored by `dev-watcher.ts` on the app side):
///   `app_data_dir/extensions/<ext_id>/dev/extension.js`  — rebuilt JS bundle
///   `app_data_dir/extensions/<ext_id>/dev/manifest.json` — copy of manifest
///   `app_data_dir/extensions/<ext_id>/dev/.watch`        — timestamp; app polls this
///
/// Runs until killed (Ctrl+C). Exit codes: 0 = normal termination via signal.
pub fn watch(path: &str, ide_root_arg: Option<&Path>, interval_ms: u64) -> Result<i32> {
    let ext_dir = PathBuf::from(path);
    if !ext_dir.join("manifest.json").is_file() {
        bail!("no manifest.json at {path}");
    }

    let ide_root = resolve_ide_root(ide_root_arg, &ext_dir)?;
    let manifest = read_manifest(&ext_dir)?;
    let ext_id = manifest.id.clone();

    let dev_dir = sindri_core::extension_dev_dir(&ext_id)
        .context("cannot resolve app_data_dir for dev watch")?;

    let start = std::time::Instant::now();
    let elapsed = || format!("{:.0}s", start.elapsed().as_secs_f64());

    println!("sindri ext watch — {ext_id}");
    println!("  source  : {}", ext_dir.display());
    println!("  dev dir : {}", dev_dir.display());
    println!("  interval: {interval_ms}ms · Ctrl+C to stop\n");

    // Initial build
    print!("[0s] Building...");
    let t = std::time::Instant::now();
    match build_extension(&ext_dir, &ide_root, false, true) {
        Ok(_) => {
            match copy_dev_files(&ext_dir, &dev_dir) {
                Ok(_) => println!(" ✓  ({:.0}ms) — watching", t.elapsed().as_millis()),
                Err(e) => println!(" ✘  copy failed: {e:#}"),
            }
        }
        Err(e) => println!(" ✘  {e:#}"),
    }

    let mut mtimes = snapshot_watch_mtimes(&ext_dir);

    loop {
        std::thread::sleep(std::time::Duration::from_millis(interval_ms));

        let current = snapshot_watch_mtimes(&ext_dir);
        let changed = current.iter().any(|(p, m)| mtimes.get(p).map_or(true, |old| old != m))
            || mtimes.keys().any(|p| !current.contains_key(p));

        if !changed {
            continue;
        }

        // Debounce: let any burst of saves settle.
        std::thread::sleep(std::time::Duration::from_millis(200));
        mtimes = snapshot_watch_mtimes(&ext_dir);

        print!("[{}] Change — rebuilding...", elapsed());
        let t = std::time::Instant::now();
        match build_extension(&ext_dir, &ide_root, false, true) {
            Ok(_) => match copy_dev_files(&ext_dir, &dev_dir) {
                Ok(_) => println!(" ✓  ({:.0}ms)", t.elapsed().as_millis()),
                Err(e) => println!(" ✘  copy failed: {e:#}"),
            },
            Err(e) => eprintln!(" ✘  {e:#}"),
        }
    }
}

/// Recursively snapshot mtimes for all files under `src/`, plus `manifest.json`
/// and `package.json`.
fn snapshot_watch_mtimes(ext_dir: &Path) -> std::collections::HashMap<PathBuf, std::time::SystemTime> {
    let mut map = std::collections::HashMap::new();
    for name in ["manifest.json", "package.json"] {
        let p = ext_dir.join(name);
        if let Ok(meta) = std::fs::metadata(&p) {
            if let Ok(m) = meta.modified() {
                map.insert(p, m);
            }
        }
    }
    collect_dir_mtimes(&ext_dir.join("src"), &mut map);
    map
}

fn collect_dir_mtimes(dir: &Path, map: &mut std::collections::HashMap<PathBuf, std::time::SystemTime>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_dir_mtimes(&p, map);
        } else if let Ok(meta) = p.metadata() {
            if let Ok(m) = meta.modified() {
                map.insert(p, m);
            }
        }
    }
}

/// Copy the rebuilt bundle + manifest into the dev-reload directory and touch `.watch`.
fn copy_dev_files(ext_dir: &Path, dev_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dev_dir)
        .with_context(|| format!("cannot create dev dir {}", dev_dir.display()))?;

    // manifest.json — activation.ts reads it one level up from bundle path
    std::fs::copy(ext_dir.join("manifest.json"), dev_dir.join("manifest.json"))
        .context("copy manifest.json")?;

    // JS bundles + source maps
    for name in [
        "extension.js",
        "extension.js.map",
        "webview.js",
        "webview.js.map",
        "webview.css",
    ] {
        let src = ext_dir.join("dist").join(name);
        if src.is_file() {
            std::fs::copy(&src, dev_dir.join(name))
                .with_context(|| format!("copy {name}"))?;
        }
    }

    // Touch .watch with current unix timestamp — the app polls this for mtime changes.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();
    std::fs::write(dev_dir.join(".watch"), &ts).context("write .watch")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_quoted_value() {
        assert_eq!(
            replace_first_quoted(" \"0.1.0\",", "0.2.0").unwrap(),
            " \"0.2.0\","
        );
    }

    #[test]
    fn manifest_version_rewrite_preserves_other_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("manifest.json"),
            "{\n  \"id\": \"a.b\",\n  \"version\": \"1.2.3\",\n  \"name\": \"X\"\n}\n",
        )
        .unwrap();
        write_manifest_version(dir.path(), "1.3.0").unwrap();
        let out = std::fs::read_to_string(dir.path().join("manifest.json")).unwrap();
        assert!(out.contains("\"version\": \"1.3.0\""));
        assert!(out.contains("\"id\": \"a.b\""));
        assert!(out.ends_with("}\n"));
    }

    #[test]
    fn civil_date_known_epoch() {
        // 2021-01-01 is 18628 days after the epoch.
        assert_eq!(civil_from_days(18_628), (2021, 1, 1));
    }
}
