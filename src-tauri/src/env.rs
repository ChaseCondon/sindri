//! The `Environment` seam (ADR-0009).
//!
//! Everything the core does to a filesystem or a process goes through an
//! [`Environment`]. [`LocalEnvironment`] is the only implementation today; WSL,
//! container, and SSH backends will land behind the same trait without touching
//! call sites.
//!
//! Built **async from day one** on purpose: remote backends are inherently
//! IO-bound, and retrofitting async across every file/process call site later is
//! exactly the rewrite this seam exists to avoid (ADR-0009, "the single most
//! invasive constraint on the core's design"). [`async_trait`] keeps the trait
//! object-safe so backends can be selected at runtime as `Arc<dyn Environment>`.

use std::collections::HashMap;
use std::process::Stdio;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A single process to run in an environment. Mirrors SAP's `ProcessSpec`
/// (ADR-0014): `argv` is **always an array, never a shell string**, so the core
/// execs directly in the environment — no shell-injection hazard and path
/// translation stays unambiguous.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessSpec {
    pub argv: Vec<String>,
    /// Target-space working directory. Defaults to the environment's project
    /// root when `None`.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Extra variables, merged over the environment's inherited env.
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub stdin: StdinMode,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StdinMode {
    #[default]
    Null,
    Inherit,
}

/// The completed result of [`Environment::exec`]. `exec` is intentionally
/// **non-streaming** (ADR-0014, `host.exec`): it is for discovery probes that
/// must finish before the UI can populate. Long-running execution goes through
/// the task lifecycle, not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecOutput {
    /// Process exit code, or `None` if terminated by a signal.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// A directory entry returned by [`Environment::list_dir`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    /// Absolute path to this entry.
    pub path: String,
    pub is_dir: bool,
}

/// Typed, scoped errors (ADR-0014). Deliberately small for v0; remote backends
/// will add variants (e.g. transport failures) behind the same enum.
#[derive(Debug, thiserror::Error)]
pub enum EnvError {
    #[error("path not found: {0}")]
    NotFound(String),
    #[error("io error on {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("spawn failed for {argv0}: {source}")]
    Spawn {
        argv0: String,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid process spec: {0}")]
    InvalidSpec(String),
    #[error("glob error: {0}")]
    Glob(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
}

/// The core's single abstraction over *where files live and where commands run*
/// (ADR-0009). Every filesystem and process call site in the core depends on
/// this trait, never on the local host directly — so swapping in a WSL,
/// container, or SSH backend is "just another `Environment`".
#[async_trait]
pub trait Environment: Send + Sync {
    /// Stable identifier for the active backend (e.g. `"local"`).
    fn id(&self) -> &str;

    /// Read a UTF-8 file. (Binary reads will get a separate `fs_read_bytes`
    /// when a call site needs them.)
    async fn fs_read(&self, path: &str) -> Result<String, EnvError>;
    async fn fs_write(&self, path: &str, contents: &str) -> Result<(), EnvError>;
    async fn fs_exists(&self, path: &str) -> Result<bool, EnvError>;
    async fn fs_glob(&self, pattern: &str) -> Result<Vec<String>, EnvError>;

    /// List the immediate children of a directory, sorted: dirs first, then
    /// files, both case-insensitively alphabetical.
    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>, EnvError>;

    /// Create a new empty file. Errors if the path already exists.
    async fn fs_create_file(&self, path: &str) -> Result<(), EnvError>;

    /// Create a new directory. Errors if the path already exists.
    async fn fs_create_dir(&self, path: &str) -> Result<(), EnvError>;

    /// Run a process to completion and return its captured output. Non-streaming
    /// by contract — see [`ExecOutput`].
    async fn exec(&self, spec: &ProcessSpec) -> Result<ExecOutput, EnvError>;
}

/// The host machine — the only [`Environment`] in v0. Loose files are always
/// `local` (ADR-0008).
#[derive(Debug, Default, Clone)]
pub struct LocalEnvironment;

#[async_trait]
impl Environment for LocalEnvironment {
    fn id(&self) -> &str {
        "local"
    }

    async fn fs_read(&self, path: &str) -> Result<String, EnvError> {
        tokio::fs::read_to_string(path)
            .await
            .map_err(|e| map_io(path, e))
    }

    async fn fs_write(&self, path: &str, contents: &str) -> Result<(), EnvError> {
        tokio::fs::write(path, contents)
            .await
            .map_err(|e| map_io(path, e))
    }

    async fn fs_exists(&self, path: &str) -> Result<bool, EnvError> {
        tokio::fs::try_exists(path)
            .await
            .map_err(|e| map_io(path, e))
    }

    async fn fs_glob(&self, pattern: &str) -> Result<Vec<String>, EnvError> {
        let pattern = pattern.to_owned();
        // `glob` is synchronous; keep it off the async worker threads.
        tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            for entry in glob::glob(&pattern).map_err(|e| EnvError::Glob(e.to_string()))? {
                let path = entry.map_err(|e| EnvError::Glob(e.to_string()))?;
                out.push(path.to_string_lossy().into_owned());
            }
            Ok(out)
        })
        .await
        .map_err(|e| EnvError::Glob(format!("glob task panicked: {e}")))?
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>, EnvError> {
        let mut read_dir = tokio::fs::read_dir(path)
            .await
            .map_err(|e| map_io(path, e))?;

        let mut entries = Vec::new();
        while let Some(entry) = read_dir.next_entry().await.map_err(|e| map_io(path, e))? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let full_path = entry.path().to_string_lossy().into_owned();
            let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            entries.push(DirEntry { name, path: full_path, is_dir });
        }

        // Dirs before files; each group sorted case-insensitively.
        entries.sort_unstable_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        Ok(entries)
    }

    async fn fs_create_file(&self, path: &str) -> Result<(), EnvError> {
        if tokio::fs::try_exists(path).await.map_err(|e| map_io(path, e))? {
            return Err(EnvError::AlreadyExists(path.to_owned()));
        }
        tokio::fs::write(path, "").await.map_err(|e| map_io(path, e))
    }

    async fn fs_create_dir(&self, path: &str) -> Result<(), EnvError> {
        if tokio::fs::try_exists(path).await.map_err(|e| map_io(path, e))? {
            return Err(EnvError::AlreadyExists(path.to_owned()));
        }
        tokio::fs::create_dir(path).await.map_err(|e| map_io(path, e))
    }

    async fn exec(&self, spec: &ProcessSpec) -> Result<ExecOutput, EnvError> {
        let (program, args) = spec
            .argv
            .split_first()
            .ok_or_else(|| EnvError::InvalidSpec("argv must be non-empty".into()))?;

        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args);
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        cmd.envs(&spec.env);
        cmd.stdin(match spec.stdin {
            StdinMode::Null => Stdio::null(),
            StdinMode::Inherit => Stdio::inherit(),
        });
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let output = cmd.output().await.map_err(|source| EnvError::Spawn {
            argv0: program.clone(),
            source,
        })?;

        Ok(ExecOutput {
            code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

fn map_io(path: &str, source: std::io::Error) -> EnvError {
    if source.kind() == std::io::ErrorKind::NotFound {
        EnvError::NotFound(path.to_owned())
    } else {
        EnvError::Io {
            path: path.to_owned(),
            source,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(argv: &[&str]) -> ProcessSpec {
        ProcessSpec {
            argv: argv.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: HashMap::new(),
            stdin: StdinMode::Null,
        }
    }

    #[tokio::test]
    async fn exec_captures_stdout_and_code() {
        let env = LocalEnvironment;
        let out = env.exec(&spec(&["echo", "hi"])).await.unwrap();
        assert_eq!(out.code, Some(0));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }

    #[tokio::test]
    async fn exec_rejects_empty_argv() {
        let env = LocalEnvironment;
        let err = env.exec(&spec(&[])).await.unwrap_err();
        assert!(matches!(err, EnvError::InvalidSpec(_)));
    }

    #[tokio::test]
    async fn fs_exists_reports_missing() {
        let env = LocalEnvironment;
        assert!(!env.fs_exists("/no/such/sindri/path").await.unwrap());
    }
}
