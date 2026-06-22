use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use super::build::{build_extension, resolve_ide_root};
use super::version::read_manifest;

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
