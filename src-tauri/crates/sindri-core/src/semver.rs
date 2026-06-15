//! Minimal semver + conventional-commit bump inference (ADR-0033 §5).
//!
//! Extensions use bare `x.y.z` versions (no pre-release in the source of truth).
//! Bump level is inferred from conventional-commit prefixes on the commits that
//! touched an extension's directory: `feat` → minor, `fix` → patch,
//! `!` / `BREAKING CHANGE` → major. This is the automatic-by-default half of the
//! hybrid model; explicit changeset-style overrides are layered on later.

use std::fmt;

/// A parsed `x.y.z` version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    pub fn parse(s: &str) -> Option<Version> {
        let mut it = s.split('.');
        let major = it.next()?.parse().ok()?;
        let minor = it.next()?.parse().ok()?;
        let patch = it.next()?.parse().ok()?;
        if it.next().is_some() {
            return None;
        }
        Some(Version { major, minor, patch })
    }

    pub fn bump(self, level: BumpLevel) -> Version {
        match level {
            BumpLevel::Major => Version {
                major: self.major + 1,
                minor: 0,
                patch: 0,
            },
            BumpLevel::Minor => Version {
                major: self.major,
                minor: self.minor + 1,
                patch: 0,
            },
            BumpLevel::Patch => Version {
                major: self.major,
                minor: self.minor,
                patch: self.patch + 1,
            },
            BumpLevel::None => self,
        }
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Inferred release impact, highest-wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BumpLevel {
    None = 0,
    Patch = 1,
    Minor = 2,
    Major = 3,
}

impl BumpLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            BumpLevel::None => "none",
            BumpLevel::Patch => "patch",
            BumpLevel::Minor => "minor",
            BumpLevel::Major => "major",
        }
    }
}

impl fmt::Display for BumpLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Infer the bump level for a single conventional-commit message.
///
/// Recognises `type(scope)!: …` headers and a `BREAKING CHANGE:` footer in the
/// body. `feat` → minor, `fix` → patch, any `!`/breaking footer → major. Other
/// types (chore, docs, refactor, …) contribute `None` on their own.
pub fn level_for_commit(message: &str) -> BumpLevel {
    let mut lines = message.lines();
    let header = lines.next().unwrap_or("");

    // BREAKING CHANGE in any body line, or a `!` before the `:` in the header.
    let breaking_footer = message
        .lines()
        .any(|l| l.trim_start().starts_with("BREAKING CHANGE"));

    let (type_part, _desc) = match header.split_once(':') {
        Some((t, d)) => (t.trim(), d),
        None => return BumpLevel::None,
    };

    let bang = type_part.ends_with('!');
    if bang || breaking_footer {
        return BumpLevel::Major;
    }

    // Strip an optional `(scope)` to get the bare type.
    let bare_type = type_part.split('(').next().unwrap_or(type_part).trim();
    match bare_type {
        "feat" => BumpLevel::Minor,
        "fix" => BumpLevel::Patch,
        _ => BumpLevel::None,
    }
}

/// Fold a set of commit messages into the highest applicable bump level.
pub fn level_for_commits<'a>(messages: impl IntoIterator<Item = &'a str>) -> BumpLevel {
    messages
        .into_iter()
        .map(level_for_commit)
        .max()
        .unwrap_or(BumpLevel::None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_display_roundtrip() {
        let v = Version::parse("1.2.3").unwrap();
        assert_eq!(v.to_string(), "1.2.3");
        assert!(Version::parse("1.2").is_none());
        assert!(Version::parse("1.2.3.4").is_none());
    }

    #[test]
    fn bumps_reset_lower_components() {
        let v = Version::parse("1.2.3").unwrap();
        assert_eq!(v.bump(BumpLevel::Major).to_string(), "2.0.0");
        assert_eq!(v.bump(BumpLevel::Minor).to_string(), "1.3.0");
        assert_eq!(v.bump(BumpLevel::Patch).to_string(), "1.2.4");
        assert_eq!(v.bump(BumpLevel::None).to_string(), "1.2.3");
    }

    #[test]
    fn conventional_commit_levels() {
        assert_eq!(level_for_commit("feat: add grid"), BumpLevel::Minor);
        assert_eq!(level_for_commit("fix(grid): off-by-one"), BumpLevel::Patch);
        assert_eq!(level_for_commit("feat!: drop legacy api"), BumpLevel::Major);
        assert_eq!(level_for_commit("chore: tidy"), BumpLevel::None);
        assert_eq!(
            level_for_commit("refactor: x\n\nBREAKING CHANGE: y"),
            BumpLevel::Major
        );
    }

    #[test]
    fn highest_level_wins() {
        let msgs = ["chore: a", "fix: b", "feat: c"];
        assert_eq!(level_for_commits(msgs), BumpLevel::Minor);
    }
}
