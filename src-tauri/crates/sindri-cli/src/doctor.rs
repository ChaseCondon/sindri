//! `sindri doctor` — diagnose the local toolchain and show resolved data dirs.
//!
//! ADR-0033 §7: `ext build` needs `bun` on `PATH` until the pinned-esbuild fetch
//! lands, so doctor must report its presence clearly. It also surfaces the
//! `sindri-core`-resolved data/cache/log dirs the CLI will read and write.

use anyhow::Result;
use serde::Serialize;

use crate::git::tool_version;

#[derive(Serialize)]
struct Tool {
    name: &'static str,
    found: bool,
    version: Option<String>,
    /// Why the CLI needs it — printed to help the user fix a gap.
    purpose: &'static str,
    required: bool,
}

#[derive(Serialize)]
struct Dirs {
    app_data: Option<String>,
    app_cache: Option<String>,
    app_log: Option<String>,
    temp: String,
}

#[derive(Serialize)]
struct Report {
    tools: Vec<Tool>,
    dirs: Dirs,
    ok: bool,
}

fn check(name: &'static str, purpose: &'static str, required: bool) -> Tool {
    let version = tool_version(name);
    Tool {
        name,
        found: version.is_some(),
        version,
        purpose,
        required,
    }
}

pub fn run(json: bool) -> Result<i32> {
    let tools = vec![
        check("git", "changed/plan/bump + release tagging", true),
        check("gh", "ext release (gh release create)", false),
        check("bun", "ext build (JS bundle step, ADR-0033 §7)", false),
    ];

    let opt = |r: Result<std::path::PathBuf, _>| r.ok().map(|p| p.display().to_string());
    let dirs = Dirs {
        app_data: opt(sindri_core::app_data_dir()),
        app_cache: opt(sindri_core::app_cache_dir()),
        app_log: opt(sindri_core::app_log_dir()),
        temp: sindri_core::paths::temp_dir().display().to_string(),
    };

    let ok = tools.iter().all(|t| !t.required || t.found);

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&Report { tools, dirs, ok })?
        );
    } else {
        println!("sindri doctor\n");
        println!("Toolchain:");
        for t in &tools {
            let mark = if t.found { "✓" } else if t.required { "✘" } else { "—" };
            let ver = t.version.as_deref().unwrap_or("not found");
            let req = if t.required { " (required)" } else { " (optional)" };
            println!("  {mark} {:<4} {}{}", t.name, ver, req);
            if !t.found {
                println!("        needed for: {}", t.purpose);
            }
        }
        println!("\nData directories ({}):", sindri_core::IDENTIFIER);
        println!("  app_data   {}", dirs.app_data.as_deref().unwrap_or("<unresolved>"));
        println!("  app_cache  {}", dirs.app_cache.as_deref().unwrap_or("<unresolved>"));
        println!("  app_log    {}", dirs.app_log.as_deref().unwrap_or("<unresolved>"));
        println!("  temp       {}", dirs.temp);
        println!("\n{}", if ok { "✓ all required tools present" } else { "✘ missing required tools" });
    }

    Ok(if ok { 0 } else { 1 })
}
