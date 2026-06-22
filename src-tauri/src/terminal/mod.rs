//! PTY-backed terminal sessions for the terminal panel (Phase 3).
//!
//! One `TerminalManager` is managed as Tauri state.  Each session owns a
//! master PTY half + a writer; a dedicated `std::thread` reads the slave
//! output and emits `term-data:<id>` events to the frontend.  When the
//! shell exits the thread emits `term-exit:<id>` and the session is removed.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::{AppHandle, Emitter, State};

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

struct Session {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

fn detect_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        return shell;
    }
    platform_default_shell().to_string()
}

#[cfg(target_os = "macos")]
fn platform_default_shell() -> &'static str { "/bin/zsh" }

#[cfg(target_os = "windows")]
fn platform_default_shell() -> &'static str { "cmd.exe" }

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_default_shell() -> &'static str { "/bin/bash" }

#[derive(serde::Serialize)]
pub struct TermSession {
    pub id: String,
    /// Filename of the shell binary, e.g. "zsh", "bash".
    pub shell: String,
}

type PtyParts = (
    Box<dyn portable_pty::MasterPty + Send>,
    Box<dyn Write + Send>,
    Box<dyn Read + Send>,
);

/// Open a PTY, spawn the shell on the slave, and return (master, writer, reader).
fn open_pty(
    pty_system: &NativePtySystem,
    size: PtySize,
    shell_path: &str,
    cwd: Option<&str>,
) -> Result<PtyParts, String> {
    let pair = pty_system.openpty(size).map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(shell_path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
        cmd.cwd(dir);
    }

    pair.slave.spawn_command(cmd).map_err(|e| format!("spawn: {e}"))?;
    // Drop slave end — the master keeps the session alive.
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| format!("take_writer: {e}"))?;
    let reader = pair.master.try_clone_reader().map_err(|e| format!("clone_reader: {e}"))?;
    Ok((pair.master, writer, reader))
}

/// Best-effort diagnostics gathered when PTY allocation fails, surfaced in the
/// error so we can tell device exhaustion from fd exhaustion without a debugger.
fn pty_diagnostics() -> String {
    let open_fds = std::fs::read_dir("/dev/fd").map(|d| d.count()).unwrap_or(0);
    let ptmx = match std::fs::OpenOptions::new().read(true).write(true).open("/dev/ptmx") {
        Ok(_) => "open-ok".to_string(),
        Err(e) => format!("open-err({})", e.raw_os_error().unwrap_or(-1)),
    };
    format!("[diag open_fds={open_fds} /dev/ptmx={ptmx}]")
}

/// Create a new PTY session.  Returns `{ id, shell }` on success.
///
/// PTY output streams as `term-data:<id>` events (`Vec<u8>` payload).
/// Shell exit fires `term-exit:<id>` and removes the session.
///
/// `shell` overrides auto-detection (`$SHELL` / platform default).
/// `cwd` sets the starting directory; `None` inherits the process CWD.
///
/// **PTY allocation runs on a dedicated OS thread.** macOS `openpty()` is
/// sensitive to the calling thread's process context: it fails with EAGAIN (35)
/// from the Tokio runtime pool and ENXIO (6) from the AppKit main thread (where
/// Tauri runs sync commands). A freshly spawned `std::thread` is neither, and
/// allocates the PTY reliably.
#[tauri::command]
pub fn term_create(
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
    app: AppHandle,
    manager: State<'_, TerminalManager>,
) -> Result<TermSession, String> {
    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed).to_string();

    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let shell_path = shell.filter(|s| !s.is_empty()).unwrap_or_else(detect_shell);
    let shell_name = std::path::Path::new(&shell_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("shell")
        .to_string();

    // Allocate the PTY on a dedicated thread, with a short back-off retry to ride
    // out transient resource pressure from fork().
    let sp = shell_path.clone();
    let cwd2 = cwd.clone();
    let result = std::thread::Builder::new()
        .name("term-openpty".into())
        .spawn(move || {
            let pty_system = NativePtySystem::default();
            let mut last_err = String::from("failed to create PTY");
            for attempt in 0..3u32 {
                if attempt > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(80 * attempt as u64));
                }
                match open_pty(&pty_system, size, &sp, cwd2.as_deref()) {
                    Ok(parts) => return Ok(parts),
                    Err(e) => last_err = e,
                }
            }
            Err(last_err)
        })
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| "PTY allocation thread panicked".to_string())?;

    let (master, writer, reader) = match result {
        Ok(parts) => parts,
        Err(e) => return Err(format!("{e} {}", pty_diagnostics())),
    };

    // Reader thread: pump PTY output → Tauri events.
    let id_clone = id.clone();
    let app_clone = app.clone();
    std::thread::Builder::new()
        .name(format!("term-reader-{id_clone}"))
        .spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = app_clone.emit(
                            &format!("term-data:{id_clone}"),
                            buf[..n].to_vec(),
                        );
                    }
                }
            }
            let _ = app_clone.emit(&format!("term-exit:{id_clone}"), ());
        })
        .map_err(|e| e.to_string())?;

    manager
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), Session { master, writer });

    Ok(TermSession { id, shell: shell_name })
}

/// Write raw bytes to the PTY (keyboard input, paste, etc.).
#[tauri::command]
pub fn term_write(
    id: String,
    data: Vec<u8>,
    manager: State<'_, TerminalManager>,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no session {id}"))?;
    session.writer.write_all(&data).map_err(|e| e.to_string())
}

/// Notify the PTY of a terminal resize (cols × rows).
#[tauri::command]
pub fn term_resize(
    id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalManager>,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("no session {id}"))?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Close a PTY session (drops master + writer, killing the shell).
#[tauri::command]
pub fn term_close(
    id: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), String> {
    manager.sessions.lock().unwrap().remove(&id);
    Ok(())
}

/// Enumerate installed monospace font families, alphabetized.
///
/// Monospace-ness is read from each family's actual font metrics (the `post`
/// table fixed-pitch flag) rather than guessed from the name, so the list is
/// both complete and accurate. Only installed families are returned, so any
/// selection in the picker is guaranteed to render correctly.
#[tauri::command]
pub fn list_terminal_fonts() -> Vec<String> {
    use font_kit::family_name::FamilyName;
    use font_kit::properties::Properties;
    use font_kit::source::SystemSource;

    let source = SystemSource::new();
    let families = source.all_families().unwrap_or_default();
    let props = Properties::new();

    let mut out: Vec<String> = families
        .into_iter()
        .filter(|fam| {
            source
                .select_best_match(&[FamilyName::Title(fam.clone())], &props)
                .and_then(|h| h.load().map_err(|_| font_kit::error::SelectionError::NotFound))
                .map(|font| font.is_monospace())
                .unwrap_or(false)
        })
        .collect();
    out.sort_by_key(|s| s.to_lowercase());
    out.dedup();
    out
}
