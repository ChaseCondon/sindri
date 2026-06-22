//! Minimal semver + conventional-commit bump inference (ADR-0033 §5).
//!
//! Extensions use bare `x.y.z` versions (no pre-release in the source of truth).
//! Bump level is inferred from conventional-commit prefixes on the commits that
//! touched an extension's directory: `feat` → minor, `fix` → patch,
//! `!` / `BREAKING CHANGE` → major. This is the automatic-by-default half of the
//! hybrid model; explicit changeset-style overrides are layered on later.

use std::fmt;

/// A parsed `x.y.z` version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
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

// ── Version requirement / engine compat gate (ADR-0040) ──────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Gte,
    Gt,
    Lte,
    Lt,
    Eq,
}

#[derive(Debug, Clone, Copy)]
struct Comparator {
    op: Op,
    version: Version,
}

impl Comparator {
    fn matches(self, v: Version) -> bool {
        match self.op {
            Op::Gte => v >= self.version,
            Op::Gt  => v >  self.version,
            Op::Lte => v <= self.version,
            Op::Lt  => v <  self.version,
            Op::Eq  => v == self.version,
        }
    }

    fn is_lower_bound(self) -> bool { matches!(self.op, Op::Gte | Op::Gt) }
    fn is_upper_bound(self) -> bool { matches!(self.op, Op::Lte | Op::Lt) }
}

/// A parsed semver range — supports `>=`, `>`, `<=`, `<`, `=`/bare-exact, `^`, `~`, `*`/empty.
pub struct VersionReq {
    comparators: Vec<Comparator>,
    wildcard: bool,
}

impl VersionReq {
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        if s.is_empty() || s == "*" {
            return Ok(Self { comparators: Vec::new(), wildcard: true });
        }
        let mut comparators = Vec::new();
        for part in s.split_whitespace() {
            let comps = parse_comparators(part)
                .ok_or_else(|| format!("invalid version range part: {part}"))?;
            comparators.extend(comps);
        }
        Ok(Self { comparators, wildcard: false })
    }

    pub fn matches(&self, v: &Version) -> bool {
        if self.wildcard { return true; }
        self.comparators.iter().all(|c| c.matches(*v))
    }
}

fn parse_comparators(s: &str) -> Option<Vec<Comparator>> {
    macro_rules! cmp {
        ($op:expr, $rest:expr) => {{
            let v = Version::parse($rest)?;
            Some(vec![Comparator { op: $op, version: v }])
        }};
    }

    if let Some(r) = s.strip_prefix(">=") { return cmp!(Op::Gte, r); }
    if let Some(r) = s.strip_prefix("<=") { return cmp!(Op::Lte, r); }
    if let Some(r) = s.strip_prefix('>') { return cmp!(Op::Gt,  r); }
    if let Some(r) = s.strip_prefix('<') { return cmp!(Op::Lt,  r); }
    if let Some(r) = s.strip_prefix('=') { return cmp!(Op::Eq,  r); }

    if let Some(r) = s.strip_prefix('^') {
        let v = Version::parse(r)?;
        let upper = if v.major > 0 {
            Version { major: v.major + 1, minor: 0, patch: 0 }
        } else if v.minor > 0 {
            Version { major: 0, minor: v.minor + 1, patch: 0 }
        } else {
            Version { major: 0, minor: 0, patch: v.patch + 1 }
        };
        return Some(vec![
            Comparator { op: Op::Gte, version: v },
            Comparator { op: Op::Lt,  version: upper },
        ]);
    }

    if let Some(r) = s.strip_prefix('~') {
        let v = Version::parse(r)?;
        let upper = Version { major: v.major, minor: v.minor + 1, patch: 0 };
        return Some(vec![
            Comparator { op: Op::Gte, version: v },
            Comparator { op: Op::Lt,  version: upper },
        ]);
    }

    // Bare x.y.z → exact
    if s.starts_with(|c: char| c.is_ascii_digit()) {
        return cmp!(Op::Eq, s);
    }

    None
}

/// Outcome of comparing an extension's `engines.sindri` range against the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Compat {
    Ok,
    /// Host is older than the range requires; upgrading Sindri will fix it.
    HostTooOld { required: String, host: String },
    /// Host is newer than the range allows; the extension may need an update.
    HostTooNew { required: String, host: String },
    /// The range string itself is malformed.
    BadRange(String),
}

/// Check whether `host` (an `x.y.z` string) satisfies `range` (`engines.sindri`).
///
/// `range = None` → `Ok` (absent field means no constraint).
pub fn check_engine(range: Option<&str>, host: &str) -> Compat {
    let range_str = match range {
        None => return Compat::Ok,
        Some(s) => s,
    };

    let req = match VersionReq::parse(range_str) {
        Ok(r) => r,
        Err(e) => return Compat::BadRange(e),
    };

    if req.wildcard {
        return Compat::Ok;
    }

    let host_ver = match Version::parse(host) {
        Some(v) => v,
        None => return Compat::BadRange(format!("invalid host version: {host}")),
    };

    if req.matches(&host_ver) {
        return Compat::Ok;
    }

    // Find the first failing comparator and determine direction.
    for c in &req.comparators {
        if !c.matches(host_ver) {
            if c.is_lower_bound() {
                return Compat::HostTooOld {
                    required: range_str.to_owned(),
                    host: host.to_owned(),
                };
            }
            if c.is_upper_bound() {
                return Compat::HostTooNew {
                    required: range_str.to_owned(),
                    host: host.to_owned(),
                };
            }
            // Exact-match failure: direction from host vs required version.
            if host_ver < c.version {
                return Compat::HostTooOld {
                    required: range_str.to_owned(),
                    host: host.to_owned(),
                };
            } else {
                return Compat::HostTooNew {
                    required: range_str.to_owned(),
                    host: host.to_owned(),
                };
            }
        }
    }

    Compat::Ok
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

    // ── check_engine / VersionReq tests (ADR-0040) ───────────────────────────

    #[test]
    fn engine_absent() {
        assert_eq!(check_engine(None, "0.1.0"), Compat::Ok);
    }

    #[test]
    fn engine_wildcard() {
        assert_eq!(check_engine(Some("*"), "0.1.0"), Compat::Ok);
        assert_eq!(check_engine(Some(""),  "0.1.0"), Compat::Ok);
    }

    #[test]
    fn engine_floor_exact_match() {
        // ^0.0.1 → >=0.0.1 <0.0.2 — the floor version itself must be Ok
        assert_eq!(check_engine(Some("^0.0.1"), "0.0.1"), Compat::Ok);
    }

    #[test]
    fn engine_caret_0x_upper_bound() {
        // ^0.1.0 → >=0.1.0 <0.2.0 — host 0.2.0 is too new
        assert_eq!(
            check_engine(Some("^0.1.0"), "0.2.0"),
            Compat::HostTooNew { required: "^0.1.0".into(), host: "0.2.0".into() }
        );
        // …but 0.1.9 is fine
        assert_eq!(check_engine(Some("^0.1.0"), "0.1.9"), Compat::Ok);
    }

    #[test]
    fn engine_tilde() {
        // ~1.2.3 → >=1.2.3 <1.3.0
        assert_eq!(check_engine(Some("~1.2.3"), "1.2.9"), Compat::Ok);
        assert_eq!(
            check_engine(Some("~1.2.3"), "1.3.0"),
            Compat::HostTooNew { required: "~1.2.3".into(), host: "1.3.0".into() }
        );
    }

    #[test]
    fn engine_too_old() {
        assert_eq!(
            check_engine(Some(">=1.0.0"), "0.9.0"),
            Compat::HostTooOld { required: ">=1.0.0".into(), host: "0.9.0".into() }
        );
    }

    #[test]
    fn engine_too_new() {
        assert_eq!(
            check_engine(Some("<1.0.0"), "1.0.0"),
            Compat::HostTooNew { required: "<1.0.0".into(), host: "1.0.0".into() }
        );
    }

    #[test]
    fn engine_malformed() {
        assert!(matches!(check_engine(Some("@#$"), "0.1.0"), Compat::BadRange(_)));
        assert!(matches!(check_engine(Some(">=bad"), "0.1.0"), Compat::BadRange(_)));
    }
}
