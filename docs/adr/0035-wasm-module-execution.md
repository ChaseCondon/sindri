# ADR-0035: WASM module execution — `sindri.wasm.load()`

- **Status:** Accepted — 2026-06-12
- **Follows from:** [ADR-0025](0025-js-extension-host-deno-v8.md) (Deno/V8 isolate natively supports WebAssembly) · [ADR-0031](0031-resource-url-scheme.md) (bundle dir registration pattern)
- **Phase:** 1.5h — Extension author DX · unblocks `sindri-token-counter`

---

## Context

Extensions that perform compute-intensive work (tokenisation, AST parsing, syntax highlighting) benefit from offloading that work to native-speed compiled modules. WebAssembly is the right vehicle: it is language-agnostic, sandboxed, runs at near-native speed inside any V8 isolate, and can be authored in Rust, C, Zig, or any wasm-targeting toolchain.

The Deno/V8 isolate (ADR-0025) supports WebAssembly natively — `WebAssembly.compile()`, `WebAssembly.instantiate()`, and the full WASM JS API are available in every isolate with no additional configuration. The only missing piece is a way to **get WASM bytes from disk into the isolate**.

`sindri.env.fs.read()` returns UTF-8 strings, so it cannot carry binary `.wasm` files. A dedicated low-level op is needed to bridge this gap.

### Constraints

- Extension host has no DOM/`fetch()` — only op-bridged calls can perform I/O.
- WASM files are bundled inside `.sinxt` archives for installed extensions and on the filesystem for dev extensions — the loading path must work in both cases.
- Extensions should not reference WASM files outside their own bundle directory (natural sandboxing, not enforced in Phase 1; enforced in Phase 7).
- No startup snapshot complications: `WebAssembly.compile()` is lazy and has no global side-effects at bootstrap time.

---

## Decision

### §1. New op: `op_wasm_load(abs_path) → Uint8Array`

A single new op reads a file at an absolute path and returns raw bytes as a `Uint8Array`. The bootstrap wraps it into the `sindri.wasm.load()` high-level API (§2); the op itself is intentionally minimal.

```rust
#[op2(async)]
#[buffer]
async fn op_wasm_load(#[string] path: String) -> Result<Vec<u8>, JsErrorBox> {
    tokio::fs::read(&path).await
        .map_err(|e| JsErrorBox::generic(e.to_string()))
}
```

The `#[buffer]` annotation on the return value causes `deno_core` to deliver the `Vec<u8>` to JS as a `Uint8Array` (zero-copy when V8 takes ownership). No base64 round-trip.

### §2. `sindri.wasm.load(relPath)` bootstrap API

```js
// Injected at activation: absolute path of the directory containing extension.js.
// Derives from bundle_path via Path::new(bundle_path).parent().
globalThis.__sindri_bundle_dir = null;

sindri.wasm = {
  /**
   * Load and compile a WebAssembly module from a path relative to the extension's
   * bundle directory. Returns a compiled WebAssembly.Module ready for instantiation.
   *
   * @example
   *   const mod = await sindri.wasm.load("tokenizer.wasm");
   *   const { instance } = await WebAssembly.instantiate(mod, {});
   *   const count = instance.exports.approx_tokens(charCount);
   */
  async load(relPath) {
    const dir = globalThis.__sindri_bundle_dir;
    if (!dir) throw new Error("sindri.wasm: bundle dir not set");
    const sep = (dir.endsWith("/") || dir.endsWith("\\")) ? "" : "/";
    const abs = dir + sep + relPath;
    const bytes = await Deno.core.ops.op_wasm_load(abs);
    return WebAssembly.compile(bytes);
  }
};
```

Extensions then instantiate the returned `WebAssembly.Module` themselves, supplying their own imports:

```ts
const mod = await sindri.wasm.load("tokenizer.wasm");
const { instance } = await WebAssembly.instantiate(mod, {});
const tokens = instance.exports.approx_tokens(charCount) as number;
```

This keeps the extension in control of the import object and makes the API composable with any WASM module, not just modules with fixed signatures.

### §3. `__sindri_bundle_dir` global

Injected in `do_load_and_activate` immediately before the bundle runs:

```rust
let bundle_dir = Path::new(bundle_path).parent()
    .map(|p| p.to_string_lossy().into_owned())
    .unwrap_or_default();
// inject alongside __sindri_ext_id and __sindri_workspace_root:
let inject = format!(
    "globalThis.__sindri_ext_id = {ext_id_js}; \
     globalThis.__sindri_workspace_root = {workspace_root_js}; \
     globalThis.__sindri_bundle_dir = {bundle_dir_js};",
);
```

`bundle_dir` is always the **directory containing `extension.js`** (typically `<ext-root>/dist/`). WASM files co-located with the bundle JS are referenced by name only (e.g. `"tokenizer.wasm"`).

### §4. Manifest declaration — `contributes.wasm`

Extensions that bundle WASM files declare them in `manifest.json`:

```json
{
  "contributes": {
    "wasm": ["dist/tokenizer.wasm"]
  }
}
```

Paths are relative to the **extension root** (not the bundle dir), matching zip entry paths. In Phase 1 this field is used by the sinxt activation path to pre-extract WASM files.

`Contributes.wasm` is added to `sindri-core`'s `Contributes` struct:

```rust
#[serde(default)]
pub wasm: Vec<String>,
```

### §5. Sinxt activation — WASM extraction

`ext_activate_sinxt` extracts declared WASM files from the zip to the same temp directory used for the bundle JS. Layout change: temp files are now placed under a per-extension subdirectory to preserve relative paths:

**Before:**
```
$TMPDIR/sindri-sinxt-bundles/<ext_id>.bundle.js
```

**After:**
```
$TMPDIR/sindri-sinxt-bundles/<ext_id>/dist/extension.js   ← bundle_path
$TMPDIR/sindri-sinxt-bundles/<ext_id>/dist/tokenizer.wasm ← extracted WASM
```

The per-extension subdirectory (`ext_tmp_dir = tmp_dir.join(&ext_id)`) ensures that `__sindri_bundle_dir` (derived as parent of `bundle_path`) equals `ext_tmp_dir/dist/`, and WASM relative paths resolve correctly. No changes are needed in the exthost runtime — `bundle_path` already encodes everything.

For `ext_activate` (dev/source extensions): WASM is already on-disk at the correct path inside `bundle_dir`; no extraction needed.

---

## Consequences

### What changes

| File | Change |
|---|---|
| `sindri-core/src/manifest.rs` | `Contributes.wasm: Vec<String>` |
| `exthost/runtime.rs` | `op_wasm_load` op + `extension!` registration + `__sindri_bundle_dir` injection + `sindri.wasm` bootstrap |
| `lib.rs` | `ext_activate_sinxt` — per-ext temp subdir + WASM extraction from zip |
| `@sindri/api/index.d.ts` | `SindriWasm` interface + `sindri.wasm` property on global |
| `packages/sindri-api/manifest.schema.json` | `contributes.wasm` array property |
| `sindri-extensions/sindri-token-counter` | Full working extension (Rust WASM + TS + manifest) |

### What does NOT change

- `exthost/mod.rs` — `ExtHost.activate()` signature unchanged.
- `op_fs_read` — no modification; WASM loading is a separate op.
- The startup snapshot — `WebAssembly.compile()` is not called at bootstrap time; no snapshot complications.
- Existing extensions — zero behavior change; `sindri.wasm` is additive.

### Security properties

| Property | Phase 1 | Phase 7 target |
|---|---|---|
| Read scope | Any absolute path the host process can read | Scoped to `bundle_dir` subtree (path traversal check in op) |
| Sandboxing | V8 WASM sandbox — no `syscall`, no direct I/O | Unchanged |
| Import surface | Extension controls import object | Unchanged |
| Memory isolation | WASM linear memory is isolated per-instance | Unchanged |

Phase 1 trusts all extensions equally (ADR-0025 §4). WASM doesn't change this model — a trusted extension that could already read arbitrary paths via `sindri.env.fs.read()` gains no new capability from `op_wasm_load`.

---

## See also

- [ADR-0025](0025-js-extension-host-deno-v8.md) §1 — V8/Deno; WASM at Tier 1 (was reserved for Tier 2 in ADR-0015)
- [ADR-0027](0027-exec-capability-security.md) — exec capability; WASM is not exec (no syscall surface)
- [ADR-0031](0031-resource-url-scheme.md) — `bundle_dir` registration pattern (same design for WASM path resolution)
