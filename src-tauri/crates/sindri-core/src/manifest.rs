//! Extension `manifest.json` types + validation (ADR-0020, ADR-0033 §5).
//!
//! Validation is a faithful Rust port of `validateManifest` /
//! `validateManifestPaths` in `sindri-ide/scripts/build-extension.ts`, so the
//! CLI's `ext validate` matches what the bundler enforces today. `manifest.json`
//! is the single version source of truth — extensions carry no `package.json`.

use std::path::Path;

use serde::Deserialize;

/// The canonical set of manifest categories (mirrors build-extension.ts).
pub const VALID_CATEGORIES: &[&str] = &[
    "Color Theme",
    "File Icon Theme",
    "UI Icon Theme",
    "Language Support",
    "Language Pack",
    "Test & Task Adapter",
    "UI Extension",
    "Extension Pack",
    "Icon Theme Base",
];

/// Typed view of the manifest fields the CLI commands need. Unknown fields are
/// ignored; structural validation works off the raw JSON (see [`validate`]).
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub publisher: Option<String>,
    /// `false` skips both CI build and release (ADR-0020). Absent = buildable.
    #[serde(default)]
    pub buildable: Option<bool>,
    /// `false` hides the marketplace Install button. A marketplace concern only.
    #[serde(default)]
    pub available: Option<bool>,
    #[serde(default)]
    pub main: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    /// ADR-0032 inherited icon theme — `icons.json` is generated at runtime.
    #[serde(default)]
    pub extends: Option<String>,
    #[serde(default)]
    pub contributes: Option<Contributes>,
    /// Registry classification tags (e.g. `"Extension Pack"`, `"Color Theme"`).
    #[serde(default)]
    pub categories: Vec<String>,
    /// `"theme"` on collections (large community packs); absent on regular packs.
    #[serde(default, rename = "packKind")]
    pub pack_kind: Option<String>,
    /// IDs of member extensions included in this pack/collection.
    #[serde(default, rename = "extensionPack")]
    pub extension_pack: Vec<String>,
    /// ADR-0038: authoritative manifest kind (extension | pack | collection | template).
    #[serde(default, rename = "type")]
    pub manifest_type: Option<String>,
    /// ADR-0038: template IDs hosted inside this pack/collection.
    #[serde(default)]
    pub provides: Vec<String>,
}

impl Manifest {
    /// `true` unless `buildable: false` is set explicitly.
    pub fn is_buildable(&self) -> bool {
        self.buildable != Some(false)
    }

    /// The git release-marker tag for this manifest's version: `{id}-v{version}`.
    pub fn release_tag(&self) -> String {
        format!("{}-v{}", self.id, self.version)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Contributes {
    #[serde(default)]
    pub themes: Vec<PathEntry>,
    #[serde(default, rename = "iconThemes")]
    pub icon_themes: Vec<PathEntry>,
    #[serde(default, rename = "uiIconPacks")]
    pub ui_icon_packs: Vec<PathEntry>,
    #[serde(default)]
    pub grammars: Vec<PathEntry>,
    #[serde(default, rename = "treeViews")]
    pub tree_views: Vec<IconEntry>,
    #[serde(default, rename = "webviewPanels")]
    pub webview_panels: Vec<IconEntry>,
    /// Paths (relative to extension root / zip entry names) for WASM modules
    /// bundled with this extension. Used during sinxt activation to pre-extract
    /// files so op_wasm_load can read them from the temp bundle directory.
    #[serde(default)]
    pub wasm: Vec<String>,
    /// Name → relative-path map for native binaries bundled with this extension (ADR-0036).
    /// Key = logical name used in sindri.env.exec(); value = zip entry / filesystem path
    /// relative to the extension root. Extracted to temp dir at sinxt activation time.
    #[serde(default)]
    pub binaries: std::collections::HashMap<String, String>,
    /// Relative path to the l10n directory containing locale bundle files.
    /// Each bundle is named `bundle.l10n.{locale}.json` (e.g. `bundle.l10n.en-US.json`).
    /// The bundle is a flat `{ "key": "translated string" }` JSON object.
    /// Phase 1: locale is always `en-US`; `en` is tried as a fallback.
    #[serde(default)]
    pub l10n: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PathEntry {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IconEntry {
    #[serde(default)]
    pub icon: Option<String>,
}

/// A single validation problem: which field, and what's wrong.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ValidationIssue {
    pub field: String,
    pub message: String,
}

fn issue(field: &str, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        field: field.to_string(),
        message: message.into(),
    }
}

fn is_nonempty_string(v: Option<&serde_json::Value>) -> bool {
    matches!(v, Some(serde_json::Value::String(s)) if !s.trim().is_empty())
}

/// Structural validation of a parsed `manifest.json`, mirroring
/// `validateManifest` in build-extension.ts. Returns an empty vec when valid.
pub fn validate(manifest: &serde_json::Value) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();

    let serde_json::Value::Object(m) = manifest else {
        return vec![issue("(root)", "manifest is not an object")];
    };

    for f in ["id", "name", "version", "publisher", "description"] {
        if !is_nonempty_string(m.get(f)) {
            issues.push(issue(f, "required string field is missing or empty"));
        }
    }

    if let Some(serde_json::Value::String(id)) = m.get("id") {
        if !is_valid_id(id) {
            issues.push(issue(
                "id",
                format!("\"{id}\" must match ^[a-z0-9-]+\\.[a-z0-9-]+$"),
            ));
        } else if let Some(serde_json::Value::String(pubr)) = m.get("publisher") {
            if !id.starts_with(&format!("{pubr}.")) {
                issues.push(issue(
                    "publisher",
                    format!("\"{pubr}\" must be the dot-prefix of id \"{id}\""),
                ));
            }
        }
    }

    if let Some(serde_json::Value::String(version)) = m.get("version") {
        if !is_xyz_semver(version) {
            issues.push(issue(
                "version",
                format!("\"{version}\" must be semver (x.y.z)"),
            ));
        }
    }

    match m.get("categories") {
        Some(serde_json::Value::Array(cats)) if !cats.is_empty() => {
            for cat in cats {
                let ok = cat.as_str().is_some_and(|c| VALID_CATEGORIES.contains(&c));
                if !ok {
                    issues.push(issue(
                        "categories",
                        format!(
                            "unknown category \"{}\" — valid values: {}",
                            cat.as_str().unwrap_or("<non-string>"),
                            VALID_CATEGORIES.join(", ")
                        ),
                    ));
                }
            }
        }
        _ => issues.push(issue("categories", "must be a non-empty array")),
    }

    if !matches!(m.get("permissions"), Some(serde_json::Value::Array(_))) {
        issues.push(issue(
            "permissions",
            "must be an array (use [] for data-only extensions)",
        ));
    }

    let engines_ok = m
        .get("engines")
        .and_then(|e| e.get("sindri"))
        .is_some_and(|s| s.is_string());
    if !engines_ok {
        issues.push(issue("engines.sindri", "required — e.g. \">=0.1.0\""));
    }

    if !matches!(m.get("contributes"), Some(serde_json::Value::Object(_))) {
        issues.push(issue(
            "contributes",
            "required object (use {} for no contributions)",
        ));
    }

    issues
}

/// Post-validation check: every path the manifest declares exists on disk
/// (mirrors `validateManifestPaths`). Returns a list of `"rel  (context)"`
/// strings for missing files. `ext_dir` is the extension's root directory.
pub fn validate_paths(ext_dir: &Path, manifest: &Manifest) -> Vec<String> {
    let mut missing = Vec::new();
    // Inline SVG values start with '<' and are not file paths — skip file existence check.
    let mut check = |rel: &str, ctx: &str| {
        if rel.trim_start().starts_with('<') {
            return;
        }
        if !ext_dir.join(rel).exists() {
            missing.push(format!("{rel}  ({ctx})"));
        }
    };

    if let Some(main) = &manifest.main {
        check(main, "main");
    }
    if let Some(icon) = &manifest.icon {
        check(icon, "icon");
    }

    if let Some(c) = &manifest.contributes {
        for t in &c.themes {
            check(&t.path, "contributes.themes[].path");
        }
        for t in &c.grammars {
            check(&t.path, "contributes.grammars[].path");
        }
        // Inherited icon themes (ADR-0032) generate icons.json at runtime — skip.
        if manifest.extends.is_none() {
            for t in &c.icon_themes {
                check(&t.path, "contributes.iconThemes[].path");
            }
            for t in &c.ui_icon_packs {
                check(&t.path, "contributes.uiIconPacks[].path");
            }
        }
        for t in &c.tree_views {
            if let Some(icon) = &t.icon {
                check(icon, "contributes.treeViews[].icon");
            }
        }
        for t in &c.webview_panels {
            if let Some(icon) = &t.icon {
                check(icon, "contributes.webviewPanels[].icon");
            }
        }
    }

    missing
}

/// `^[a-z0-9-]+\.[a-z0-9-]+$` without a regex dependency.
fn is_valid_id(id: &str) -> bool {
    let seg_ok = |s: &str| {
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    match id.split_once('.') {
        Some((a, b)) => seg_ok(a) && seg_ok(b) && !b.contains('.'),
        None => false,
    }
}

/// `^\d+\.\d+\.\d+$` — bare three-number semver, no pre-release/build.
fn is_xyz_semver(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_manifest() -> serde_json::Value {
        json!({
            "id": "sindri.csv-grid",
            "name": "CSV Grid",
            "version": "0.1.0",
            "publisher": "sindri",
            "description": "Opens .csv files as a grid.",
            "categories": ["UI Extension"],
            "permissions": ["sindri.ui"],
            "engines": { "sindri": ">=0.1.0" },
            "contributes": {}
        })
    }

    #[test]
    fn accepts_a_valid_manifest() {
        assert!(validate(&valid_manifest()).is_empty());
    }

    #[test]
    fn flags_bad_id_format() {
        let mut m = valid_manifest();
        m["id"] = json!("CSVGrid");
        let issues = validate(&m);
        assert!(issues.iter().any(|i| i.field == "id"));
    }

    #[test]
    fn flags_publisher_prefix_mismatch() {
        let mut m = valid_manifest();
        m["publisher"] = json!("acme");
        assert!(validate(&m).iter().any(|i| i.field == "publisher"));
    }

    #[test]
    fn flags_unknown_category_and_bad_version() {
        let mut m = valid_manifest();
        m["categories"] = json!(["Nonsense"]);
        m["version"] = json!("1.0");
        let issues = validate(&m);
        assert!(issues.iter().any(|i| i.field == "categories"));
        assert!(issues.iter().any(|i| i.field == "version"));
    }

    #[test]
    fn typed_manifest_helpers() {
        let m: Manifest = serde_json::from_value(valid_manifest()).unwrap();
        assert!(m.is_buildable());
        assert_eq!(m.release_tag(), "sindri.csv-grid-v0.1.0");
    }
}
