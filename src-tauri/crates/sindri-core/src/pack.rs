//! `.sinxt` archive packaging (ADR-0020, ADR-0033 §5/§7).
//!
//! The `.sinxt` format is a deterministic zip: paths sorted, mtime fixed at
//! 1980-01-01 (the earliest ZIP-legal date), deflate level 6. This matches
//! the fflate output produced by `sindri-ide/scripts/build-extension.ts`.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};

use crate::manifest::Manifest;

/// Collect the set of file paths (relative to `ext_dir`) that belong in a
/// `.sinxt` archive: `manifest.json`, everything under `dist/` (excluding
/// other `.sinxt` files), and all assets declared in the manifest.
///
/// Mirrors `collectPackageFiles` in `sindri-ide/scripts/build-extension.ts`.
/// Returns paths sorted for deterministic archive order.
pub fn collect_package_files(ext_dir: &Path, manifest: &Manifest) -> Result<Vec<String>> {
    let mut files: BTreeSet<String> = BTreeSet::new();

    files.insert("manifest.json".to_string());

    let dist = ext_dir.join("dist");
    if dist.is_dir() {
        walk_dir(&dist, ext_dir, &mut files)?;
    }

    if let Some(icon) = &manifest.icon {
        add_if_file(ext_dir, icon, &mut files);
    }

    if let Some(c) = &manifest.contributes {
        for t in &c.themes {
            add_if_file(ext_dir, &t.path, &mut files);
        }
        for t in &c.grammars {
            add_if_file(ext_dir, &t.path, &mut files);
        }
        for t in &c.tree_views {
            if let Some(icon) = &t.icon {
                add_if_file(ext_dir, icon, &mut files);
            }
        }
        for t in &c.webview_panels {
            if let Some(icon) = &t.icon {
                add_if_file(ext_dir, icon, &mut files);
            }
        }
        for t in &c.icon_themes {
            add_if_file(ext_dir, &t.path, &mut files);
            collect_icon_svgs(ext_dir, &t.path, &mut files);
        }
        for t in &c.ui_icon_packs {
            add_if_file(ext_dir, &t.path, &mut files);
            collect_icon_svgs(ext_dir, &t.path, &mut files);
        }
        for wasm_path in &c.wasm {
            add_if_file(ext_dir, wasm_path, &mut files);
        }
        for bin_path in c.binaries.values() {
            add_if_file(ext_dir, bin_path, &mut files);
        }
    }

    Ok(files.into_iter().collect())
}

fn add_if_file(ext_dir: &Path, rel: &str, files: &mut BTreeSet<String>) {
    if ext_dir.join(rel).is_file() {
        files.insert(rel.to_string());
    }
}

/// Build the `.sinxt` bytes: deterministic zip, deflate level 6, all mtimes
/// set to 1980-01-01T00:00:00Z (the earliest ZIP-legal date).
pub fn pack_sinxt(ext_dir: &Path, files: &[String]) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zip = zip::ZipWriter::new(cursor);
        let mtime = zip::DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0)
            .expect("hardcoded date is always valid");
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(6))
            .last_modified_time(mtime);

        for rel in files {
            let abs = ext_dir.join(rel);
            let content = std::fs::read(&abs)
                .with_context(|| format!("cannot read {}", abs.display()))?;
            zip.start_file(rel, opts)?;
            zip.write_all(&content)?;
        }
        zip.finish()?;
    }
    Ok(buf)
}

/// Recursively collect all non-`.sinxt` files under `dir`, adding their paths
/// relative to `base` into `files`.
fn walk_dir(dir: &Path, base: &Path, files: &mut BTreeSet<String>) -> Result<()> {
    for entry in std::fs::read_dir(dir)
        .with_context(|| format!("cannot read {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk_dir(&path, base, files)?;
        } else if !path.extension().is_some_and(|e| e == "sinxt") {
            let rel = path
                .strip_prefix(base)
                .expect("walk_dir: path always under base")
                .to_string_lossy()
                .into_owned();
            files.insert(rel);
        }
    }
    Ok(())
}

/// For an icon theme or UI icon pack JSON at `json_rel`, read its
/// `icons[*].path` fields and add the referenced SVG paths to `files`.
///
/// Mirrors the icon-SVG crawl in `collectPackageFiles`.
fn collect_icon_svgs(ext_dir: &Path, json_rel: &str, files: &mut BTreeSet<String>) {
    let abs = ext_dir.join(json_rel);
    let Ok(raw) = std::fs::read_to_string(&abs) else {
        return;
    };
    let Ok(def) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let json_dir = std::path::Path::new(json_rel)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    if let Some(icons) = def.get("icons").and_then(|v| v.as_object()) {
        for icon in icons.values() {
            if let Some(icon_rel) = icon.get("path").and_then(|p| p.as_str()) {
                let full_rel = if json_dir.is_empty() {
                    icon_rel.to_string()
                } else {
                    format!("{json_dir}/{icon_rel}")
                };
                if ext_dir.join(&full_rel).is_file() {
                    files.insert(full_rel);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_includes_manifest_and_dist() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();

        std::fs::write(d.join("manifest.json"), r#"{"id":"a.b","version":"0.1.0"}"#).unwrap();
        std::fs::create_dir(d.join("dist")).unwrap();
        std::fs::write(d.join("dist/extension.js"), "// js").unwrap();
        std::fs::write(d.join("dist/old.sinxt"), "should be excluded").unwrap();

        let manifest = sindri_core_test_manifest();
        let files = collect_package_files(d, &manifest).unwrap();

        assert!(files.contains(&"manifest.json".to_string()));
        assert!(files.contains(&"dist/extension.js".to_string()));
        assert!(!files.iter().any(|f| f.ends_with(".sinxt")));
    }

    #[test]
    fn pack_sinxt_produces_valid_zip() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::write(d.join("manifest.json"), b"hello").unwrap();

        let bytes = pack_sinxt(d, &["manifest.json".to_string()]).unwrap();
        // Zip magic number: PK\x03\x04
        assert_eq!(&bytes[..4], b"PK\x03\x04");
    }

    fn sindri_core_test_manifest() -> Manifest {
        serde_json::from_value(serde_json::json!({
            "id": "a.b",
            "name": "Test",
            "version": "0.1.0",
            "contributes": {}
        }))
        .unwrap()
    }
}
