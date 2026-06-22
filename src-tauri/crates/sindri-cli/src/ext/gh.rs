use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context, Result};

/// Check whether a GitHub Release tag already exists (mirrors `releaseExists`
/// in `create-releases.ts`).
pub(crate) fn gh_release_exists(repo: &Path, tag: &str) -> bool {
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
pub(crate) fn gh_release_create(
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
pub(crate) fn today_ymd() -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_date_known_epoch() {
        // 2021-01-01 is 18628 days after the epoch.
        assert_eq!(civil_from_days(18_628), (2021, 1, 1));
    }
}
