use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use sindri_core::semver::{BumpLevel, Version};

use crate::git;
use super::gh::today_ymd;

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
pub(crate) fn repo_root(repo: Option<PathBuf>) -> Result<PathBuf> {
    let root = match repo {
        Some(p) => p,
        None => std::env::current_dir().context("cannot read current directory")?,
    };
    if !git::is_git_repo(&root) {
        bail!("{} is not inside a git work tree", root.display());
    }
    Ok(root)
}

pub(crate) fn read_manifest(dir: &Path) -> Result<sindri_core::Manifest> {
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
}
