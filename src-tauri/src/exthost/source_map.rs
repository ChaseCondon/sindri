use std::collections::HashMap;
use std::path::Path;

pub(super) type SourceMaps = HashMap<String, sourcemap::SourceMap>;

/// Try to load the `.js.map` file adjacent to `bundle_path` and register it.
/// Load the adjacent `{bundle_path}.map`, keyed by `frame_key` — the exact string V8
/// reports in stack frames (the `file://` script URL, ADR-0037). Keying by the frame
/// string is what lets `translate_loc` match; keying by the bare path silently breaks
/// translation once the script URL is `file://`-prefixed.
pub(super) async fn try_load_source_map(bundle_path: &str, frame_key: &str, maps: &mut SourceMaps) {
    let map_path = format!("{bundle_path}.map");
    if let Ok(bytes) = tokio::fs::read(&map_path).await {
        if let Ok(sm) = sourcemap::SourceMap::from_reader(bytes.as_slice()) {
            maps.insert(frame_key.to_string(), sm);
        }
    }
}

/// Derive the `file://` script URL V8 uses for `bundle_path`. Both the executed script
/// specifier and the source-map key are built from this so stack frames and map lookups
/// agree (ADR-0037).
pub(super) fn script_url_for(bundle_path: &str) -> String {
    if bundle_path.starts_with('/') {
        format!("file://{bundle_path}")
    } else if bundle_path.len() > 2 && bundle_path.as_bytes()[1] == b':' {
        // Windows: C:\... → file:///C:/...
        format!("file:///{}", bundle_path.replace('\\', "/"))
    } else {
        bundle_path.to_owned()
    }
}

/// Translate a V8 stack trace string, remapping any frames that reference a
/// known bundle path back to the original TypeScript source positions.
///
/// V8 frame formats handled:
///   "    at funcName (path:line:col)"
///   "    at path:line:col"  (anonymous frames)
pub(super) fn translate_stack(raw: &str, maps: &SourceMaps) -> String {
    if maps.is_empty() {
        return raw.to_string();
    }
    raw.lines().map(|line| translate_frame_line(line, maps)).collect::<Vec<_>>().join("\n")
}

fn translate_frame_line(line: &str, maps: &SourceMaps) -> String {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("at ") {
        return line.to_string();
    }

    // Parens form: "    at funcName (path:line:col)"
    if let (Some(open), Some(close)) = (line.rfind('('), line.rfind(')')) {
        if open < close {
            let inner = &line[open + 1..close];
            if let Some(translated) = translate_loc(inner, maps) {
                return format!("{}({translated})", &line[..open]);
            }
        }
    }

    // Bare form: "    at path:line:col"
    if let Some(at_pos) = line.find("at ") {
        let after_at = &line[at_pos + 3..];
        if let Some(translated) = translate_loc(after_at, maps) {
            return format!("{}at {translated}", &line[..at_pos]);
        }
    }

    line.to_string()
}

/// Try to parse `loc` as `path:line:col`, look up the source map for that path,
/// and return the translated `orig_file:orig_line:orig_col` if found.
fn translate_loc(loc: &str, maps: &SourceMaps) -> Option<String> {
    // Split from the right to isolate the col, then line, leaving the path.
    let (rest, col_str) = loc.rsplit_once(':')?;
    let (path, line_str) = rest.rsplit_once(':')?;

    let line_1: u32 = line_str.parse().ok()?;
    let col_1: u32 = col_str.parse().ok()?;

    let sm = maps.get(path)?;

    // V8 stack traces are 1-indexed for both line and column.
    // sourcemap::SourceMap::lookup_token expects 0-indexed.
    let token = sm.lookup_token(line_1.saturating_sub(1), col_1.saturating_sub(1))?;

    let src_rel = token.get_source().unwrap_or(path);
    // Resolve the (typically relative) source path against the bundle's directory.
    let src_file = if src_rel.starts_with('.') {
        let bundle_dir = Path::new(path).parent().unwrap_or(Path::new("."));
        bundle_dir.join(src_rel).to_string_lossy().into_owned()
    } else {
        src_rel.to_string()
    };

    let src_line = token.get_src_line() + 1; // back to 1-indexed
    let src_col = token.get_src_col() + 1;

    Some(format!("{src_file}:{src_line}:{src_col}"))
}
