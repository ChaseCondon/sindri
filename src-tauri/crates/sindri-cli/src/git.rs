//! Thin wrappers over the `git` CLI (ADR-0033 §5: shell `git`/`gh`, don't link
//! `git2`). All commands run with the extensions repo as the working directory.

use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context, Result};

/// Record separator used to delimit `git log` entries unambiguously.
const RS: char = '\u{1e}';

/// Run `git <args>` in `repo` and return trimmed stdout. Errors include stderr.
pub fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .with_context(|| format!("failed to spawn `git {}`", args.join(" ")))?;
    if !out.status.success() {
        bail!(
            "`git {}` failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// `git diff --name-only <since>..HEAD` — files changed since `since` (ADR-0033 §5).
pub fn changed_files(repo: &Path, since: &str) -> Result<Vec<String>> {
    let range = format!("{since}..HEAD");
    let out = git(repo, &["diff", "--name-only", &range])?;
    Ok(out.lines().map(|l| l.to_string()).collect())
}

/// Full commit messages (`%B`) for commits in `<since>..HEAD` that touched
/// `dir`, newest first. Each returned string is one whole commit message.
pub fn commit_messages(repo: &Path, since: &str, dir: &str) -> Result<Vec<String>> {
    let range = format!("{since}..HEAD");
    let format = format!("--format=%B{RS}");
    let out = git(repo, &["log", &range, &format, "--", dir])?;
    Ok(out
        .split(RS)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect())
}

/// Whether a git tag exists locally (the `{id}-v{version}` release marker).
pub fn tag_exists(repo: &Path, tag: &str) -> Result<bool> {
    let out = git(repo, &["tag", "-l", tag])?;
    Ok(out.lines().any(|l| l == tag))
}

/// Is `repo` inside a git work tree?
pub fn is_git_repo(repo: &Path) -> bool {
    Command::new("git")
        .current_dir(repo)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Report a tool's `--version` first line, or `None` if it isn't on `PATH`.
pub fn tool_version(bin: &str) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next().or_else(|| {
        // Some tools (older gh) print version to stderr.
        None
    })?;
    Some(line.trim().to_string())
}
