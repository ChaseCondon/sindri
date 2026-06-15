# ADR-0036: Native binary bundling — `contributes.binaries` + brokered path injection

- **Status:** Accepted — 2026-06-12
- **Follows from:** [ADR-0027](0027-exec-capability-security.md) (brokered exec policy · declared-binary allowlist) · [ADR-0035](0035-wasm-module-execution.md) (binary extraction pattern)
- **Phase:** 1.5i — Extension author DX · unblocks `sindri-ferris-says`

---

## Context

Some extensions need native-speed computation that WASM cannot provide: extensions that shell out to language servers, formatters, or custom CLI tools they ship themselves. ADR-0027 §3 describes the **declared-binary allowlist** security model and established that bundled binaries are the right mechanism for extension-authored native code.

The remaining design questions not covered by ADR-0027:

1. How does an extension declare which native binaries it bundles?
2. How does the host extract those binaries at activation time and make them executable?
3. How does the extension's JS reference the extracted binary without knowing the absolute installation path?
4. How is the per-extension allowlist enforced in the exec broker?

---

## Decision

### §1. `contributes.binaries` — manifest declaration

Extensions declare bundled binaries in `manifest.json` as a name → relative-path map:

```json
{
  "contributes": {
    "binaries": {
      "ferris-says": "bin/ferris-says"
    }
  }
}
```

- **Key** (`"ferris-says"`): the logical binary name used in `sindri.env.exec("ferris-says", args)`.
- **Value** (`"bin/ferris-says"`): path relative to the extension root, matching the zip entry name in the `.sinxt` archive.
- Phase 1: platform-specific selection is not implemented — the path is used verbatim. Authors compile for the target platform and commit the binary.

### §2. Binary extraction at activation

Mirrors the WASM extraction pattern from ADR-0035 §5:

**Sinxt path** (`ext_activate_sinxt`):
- For each entry in `contributes.binaries`, extract bytes from the zip.
- Write to `$TMPDIR/sindri-sinxt-bundles/<ext_id>/<rel_path>` (same per-ext subdir established in ADR-0035).
- `std::fs::set_permissions(path, executable)` — set the executable bit on Unix. On Windows, `.exe` suffix is conventional; no chmod needed.

**Dev/source path** (`ext_activate`):
- Read `manifest.json` from `bundle_dir + "/../manifest.json"` (parent of the `dist/` folder).
- For each declared binary, resolve `bundle_dir + "/../" + rel_path` to an absolute path.
- No extraction needed — the binary is already on the filesystem.
- If `bundle_dir` is `None` (test path), binary map is empty and all calls go to the `cmd` as-is.

### §3. `__sindri_bin_paths` global — path injection

At activation, the resolved `{name → absolute_path}` map is JSON-serialised and injected into the isolate:

```js
// injected alongside __sindri_ext_id, __sindri_workspace_root, __sindri_bundle_dir
globalThis.__sindri_bin_paths = { "ferris-says": "/tmp/sindri-sinxt-bundles/sindri.ferris-says/bin/ferris-says" };
```

The bootstrap's `sindri.env.exec` wrapper resolves names through this map before calling `op_env_exec`:

```js
exec: _wrapEnvOp(async (cmd, ...args) => {
  const cwd = globalThis.__sindri_workspace_root ?? null;
  const resolved = (globalThis.__sindri_bin_paths ?? {})[cmd] ?? cmd;
  return Deno.core.ops.op_env_exec(resolved, args, cwd);
}),
```

This keeps the extension code natural: `sindri.env.exec("ferris-says", "Hello")` works whether the binary is extracted from a sinxt or present on the dev filesystem. The extension never sees the absolute installation path.

### §4. Allowlist enforcement (Phase 1 posture)

ADR-0027 §3 specifies that `op_env_exec` should reject commands not in the declared allowlist. Phase 1 defers enforcement because all extensions are first-party (ADR-0027 §7). The mechanism is in place:

- The `__sindri_bin_paths` map doubles as the effective allowlist for bundled binaries in the JS layer (only declared names get resolved).
- Phase 7 will add an additional Rust-layer check in `op_env_exec` against the stored allowlist, rejecting unlisted binaries even if an extension tries to escape via an absolute path.

### §5. `contributes.binaries` in sindri-core

```rust
// sindri-core/src/manifest.rs
#[serde(default)]
pub binaries: std::collections::HashMap<String, String>,
```

`collect_package_files` (used by `sindri ext build --bundle`) must include declared binary paths in the packed `.sinxt`, analogous to how it includes `contributes.wasm` paths.

---

## Consequences

### What changes

| File | Change |
|---|---|
| `sindri-core/src/manifest.rs` | `Contributes.binaries: HashMap<String, String>` |
| `exthost/runtime.rs` | `__sindri_bin_paths` global init; `sindri.env.exec` bootstrap updated to resolve bundled names |
| `exthost/runtime.rs` (`do_load_and_activate`) | Inject `__sindri_bin_paths` JSON |
| `exthost/mod.rs` | `ExtHost.activate()` gains `bin_paths: HashMap<String, String>` |
| `exthost/runtime.rs` (`load_and_activate` / `Msg`) | Same `bin_paths` param threaded to `do_load_and_activate` |
| `lib.rs` | `ext_activate` reads manifest → resolves fs paths; `ext_activate_sinxt` extracts + chmod |
| `packages/sindri-api/manifest.schema.json` | `contributes.binaries` object property |
| `sindri-extensions/sindri-ferris-says` | Full working extension (Rust binary + TS + manifest) |

### What does NOT change

- `op_env_exec` — no Rust-layer allowlist check in Phase 1.
- The `sindri.env.exec` JS API surface — call signature is unchanged.
- The sinxt temp-dir layout from ADR-0035 — binaries land in the same `$TMPDIR/sindri-sinxt-bundles/<ext_id>/` subtree.

### Deferred

- **Platform-specific binary selection**: `{ "darwin": "bin/ferris-says-darwin", "linux": "bin/ferris-says-linux" }` shape — Phase 3.
- **Rust-layer allowlist enforcement** in `op_env_exec` — Phase 7 (when untrusted extensions exist).
- **Cleanup of temp binaries** on extension deactivation/uninstall — Phase 6.
- **Code signing / notarisation** of bundled binaries on macOS — Phase 7.

---

## See also

- [ADR-0027](0027-exec-capability-security.md) — exec security policy; brokered spawn; arg-vector rule
- [ADR-0035](0035-wasm-module-execution.md) — WASM extraction pattern (sinxt subdir layout, path injection)
- [ADR-0009](0009-remote-execution-environments.md) — `Environment` trait; `exec` routes through broker
