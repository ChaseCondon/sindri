//! Platform-agnostic data/cache/log/temp directory resolution (ADR-0033 §3).
//!
//! `sindri-core` is the single source of truth for these paths. The app stops
//! calling Tauri's resolver and calls these instead, and a parity test in the
//! app crate asserts `app_data_dir() == app.path().app_data_dir()`. This is the
//! same computation Tauri performs internally (the `dirs` crate + the bundle
//! identifier), so the CLI — which has no Tauri `AppHandle` — never drifts.

use std::path::PathBuf;

/// The bundle identifier, matching `tauri.conf.json` `identifier`.
pub const IDENTIFIER: &str = "dev.sindri.app";

/// Error returned when the OS base directory cannot be resolved (e.g. `$HOME`
/// unset on Unix). Mirrors the failure surface of Tauri's path resolver.
#[derive(Debug, thiserror::Error)]
#[error("could not resolve {what}: no OS base directory available")]
pub struct PathError {
    what: &'static str,
}

/// `~/Library/Application Support/dev.sindri.app` (macOS),
/// `%APPDATA%\dev.sindri.app` (Windows), `~/.local/share/dev.sindri.app` (Linux).
pub fn app_data_dir() -> Result<PathBuf, PathError> {
    Ok(dirs::data_dir()
        .ok_or(PathError { what: "app_data_dir" })?
        .join(IDENTIFIER))
}

/// `~/Library/Caches/dev.sindri.app` (macOS),
/// `%LOCALAPPDATA%\dev.sindri.app` (Windows), `~/.cache/dev.sindri.app` (Linux).
pub fn app_cache_dir() -> Result<PathBuf, PathError> {
    Ok(dirs::cache_dir()
        .ok_or(PathError { what: "app_cache_dir" })?
        .join(IDENTIFIER))
}

/// Log directory, matching Tauri's per-OS convention:
/// `~/Library/Logs/dev.sindri.app` (macOS),
/// `%LOCALAPPDATA%\dev.sindri.app\logs` (Windows),
/// `~/.local/share/dev.sindri.app/logs` (Linux).
pub fn app_log_dir() -> Result<PathBuf, PathError> {
    #[cfg(target_os = "macos")]
    {
        Ok(dirs::home_dir()
            .ok_or(PathError { what: "app_log_dir" })?
            .join("Library/Logs")
            .join(IDENTIFIER))
    }
    #[cfg(target_os = "windows")]
    {
        Ok(dirs::data_local_dir()
            .ok_or(PathError { what: "app_log_dir" })?
            .join(IDENTIFIER)
            .join("logs"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(dirs::data_dir()
            .ok_or(PathError { what: "app_log_dir" })?
            .join(IDENTIFIER)
            .join("logs"))
    }
}

/// The OS temp dir (no identifier suffix), matching Tauri's `temp_dir()`.
pub fn temp_dir() -> PathBuf {
    std::env::temp_dir()
}

/// Install root for a specific extension version:
/// `app_data_dir/extensions/<id>/<version>/`.
pub fn extension_install_dir(id: &str, version: &str) -> Result<PathBuf, PathError> {
    Ok(app_data_dir()?.join("extensions").join(id).join(version))
}

/// Dev-mode hot-reload directory written by `sindri ext watch`:
/// `app_data_dir/extensions/<id>/dev/`.
/// The CLI copies the rebuilt bundle here; the app polls `.watch` inside for mtime changes.
pub fn extension_dev_dir(id: &str) -> Result<PathBuf, PathError> {
    Ok(app_data_dir()?.join("extensions").join(id).join("dev"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_ends_with_identifier() {
        let d = app_data_dir().unwrap();
        assert!(d.ends_with(IDENTIFIER), "{d:?} should end with {IDENTIFIER}");
    }

    #[test]
    fn install_dir_layout() {
        let d = extension_install_dir("sindri.csv-grid", "0.1.0").unwrap();
        assert!(d.ends_with("extensions/sindri.csv-grid/0.1.0"));
    }
}
