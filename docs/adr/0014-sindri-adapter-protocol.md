# ADR-0014: Sindri Adapter Protocol (SAP)

- Status: Accepted
- Date: 2026-06-02
- Extends: [ADR-0005](0005-builtin-ide-frameworks.md), [ADR-0012](0012-project-file-format.md)
- Strengthens: [ADR-0013](0013-product-identity-and-polyglot-thesis.md)

## Context

ADR-0005 named the Sindri Adapter Protocol as the mechanism for run/test/task execution, and ADR-0012 used SAP adapter IDs (e.g. `sindri.adapter.cargo`) in the `[toolchains]` schema. Both deferred the protocol itself to a spike. This ADR closes that spike.

The key architectural constraint driving every design choice here: **adapters are JS extensions** (ADR-0006), while **all toolchain execution must happen inside the project's environment** (ADR-0009 — WSL/container/SSH). If an adapter spawned its own processes it would have to be deployed into every container and re-implement path translation. Therefore:

> **An adapter is a pure plan/parse pair. The Rust core owns process spawning, environment scoping, and host↔target path translation. An adapter describes what to run and interprets what comes back; it never touches the OS directly.**

This keeps adapters environment-agnostic: the same `cargo` adapter works unchanged locally, in a container, and over SSH.

## Decision

### Core principle: plan/parse separation

```
Adapter (JS host)              Rust core (Environment)         Toolchain (in env)
──────────────────             ───────────────────────         ──────────────────
discover(req, host)  ───────►  fs.read / host.exec (bounded)
◄──────────────────  results   path-translated, env-scoped

plan(task)           ───────►
◄──────────────────  ProcessSpec[]

                               spawn ProcessSpec in env  ────►
                     stream    stdout / stderr           ◄────
onOutput(chunk)      ◄───────  raw bytes
emit(TaskEvent[])    ───────►  structured events → UI

onExit(code)         ◄───────  process exited
emit(finished)       ───────►
```

Adapters only ever see **target-space paths** (paths as they exist inside the environment — `/workspace/...`). The core translates to and from host paths at every boundary, shielding adapter authors from environment topology entirely.

---

### Contract 1: Manifest (static capability declaration)

A JSON manifest file bundled with the adapter extension. Read once at install/project-open; never executes code. Drives gray-out of unsupported actions and zero-config toolchain auto-suggestion.

```jsonc
{
  "id": "sindri.adapter.cargo",           // must match [extensions] key
  "sapVersion": "1",                      // SAP major this adapter implements
  "toolchain": {
    "command": "cargo",                   // binary the core probes at first use
    "detect": ["Cargo.toml"]             // markers → auto-suggest [toolchains.*] binding
  },
  "capabilities": {
    "run": true,
    "test": true,
    "discover": ["run", "test"],          // which capabilities support discovery
    "debug": true,                        // can produce DapLaunchConfig
    "watch": true,                        // can produce a non-terminating task
    "coverage": false
  },
  "testKinds": ["unit", "integration", "doc"],
  "requires": {
    "tools": ["cargo"],
    "optional": ["cargo-nextest"]
  }
}
```

`detect` markers feed ADR-0012's zero-config promise: open a folder with `Cargo.toml` and Sindri suggests adding `[toolchains.rust]` automatically. `requires.tools` feeds the first-run toolchain probe (see Error model).

---

### Contract 2: Host-services API

The only way adapters interact with the outside world. All calls are environment-scoped and path-translated by the core.

| Method | Signature | Notes |
|---|---|---|
| `host.fs.read(path)` | `→ string` | UTF-8; path is target-space |
| `host.fs.glob(pattern)` | `→ string[]` | target-space paths |
| `host.fs.exists(path)` | `→ boolean` | |
| `host.exec(spec)` | `→ {code, stdout, stderr}` | **bounded** probe only — run to completion, captured, hard-timeout (default 30s). Use for `cargo metadata`, effective POM, `vitest list`. Not for streaming tasks. |

`host.exec` takes a `ProcessSpec` (same shape as `plan()` returns — see below). It is intentionally not streaming: it's for discovery probes that must complete before the UI can populate. Long-running execution goes through the task lifecycle (Contract 4), never through `host.exec`.

---

### Contract 3: Discovery

Called lazily when the Run panel or Test Explorer opens, or when the project file changes. Two-phase for test suites: cheap suite-level nodes first, test-case enumeration deferred or harvested live during a run.

```ts
interface DiscoverRequest {
  kind: "run" | "test";
  toolchainId: string;          // the [toolchains.<name>] key from sindri.toml
  rootPath: string;             // project root, target-space
}

interface RunTarget {
  id: string;                   // stable, used to request execution
  label: string;                // shown in the Run panel
  task: string;                 // adapter verb passed back in ExecuteRequest
  args?: string[];
  debuggable?: boolean;         // false means debugConfig() will not be called
}

interface TestSuite {
  id: string;
  label: string;
  file?: string;                // target-space path, for file→suite navigation
  cases?: TestCase[];           // may be empty; cases can be harvested during run
}

interface TestCase {
  id: string;                   // stable across runs; used to merge discovery + run events
  label: string;
  file?: string;
  line?: number;
}
```

**Discovery isolation**: a `DISCOVERY_FAILED` error on one toolchain must not prevent discovery on sibling toolchains. The core runs all discovery calls concurrently and surfaces each failure independently (see Error model).

**Lazy test enumeration**: if `TestSuite.cases` is empty, Sindri may call `discover({ kind: "test", ... })` again before a run to attempt enumeration. If that still returns no cases (pytest reveals cases only at collection time), the Test Explorer shows suite-level nodes and merges individual `test` events from the run into the tree by stable id.

---

### Contract 4: Execution

#### `plan(req) → ProcessSpec[]`

Returns an **ordered sequence** of process specs. The core executes them in order; any non-final spec's non-zero exit code aborts the sequence. The common case is length 1 (e.g. `cargo test`); a pre-build step is length 2 (e.g. `[{argv:["cargo","build"]}, {argv:["cargo","nextest","run"]}]`).

```ts
interface ExecuteRequest {
  taskId: string;               // stable id for the lifetime of this task
  kind: "run" | "test";
  targetId: string;             // RunTarget.id or TestSuite.id from discovery
  toolchainId: string;
  rootPath: string;             // target-space
  args?: string[];              // user-supplied extra args
  env?: Record<string,string>;  // merged over adapter defaults
  watch?: boolean;              // true → last ProcessSpec is expected to not exit
}

interface ProcessSpec {
  argv: string[];               // MUST be an array — never a shell string
  cwd?: string;                 // target-space; defaults to rootPath
  env?: Record<string,string>;  // merged over the environment's inherited env
  stdin?: "null" | "inherit";   // default "null"
}
```

**`argv` is always an array, never a shell string.** The core execs directly in the environment. This eliminates shell injection hazards and makes path translation unambiguous. The built-in `shell` adapter is the sole exception — it wraps a user-supplied command string in `["sh", "-c", command]`.

#### `onOutput(chunk: OutputChunk): TaskEvent[]`

Called with each raw output chunk from the running process. The adapter holds per-task parser state (a `ParserSession` created when the task starts and destroyed on exit). It returns zero or more `TaskEvent`s synchronously.

```ts
interface OutputChunk {
  taskId: string;
  source: "stdout" | "stderr";
  data: Uint8Array;             // raw bytes; adapter owns decoding
}
```

Stateful sessions are required (not stateless per-line callbacks) because real tool outputs are not always line-delimited: cargo emits multi-field JSON records, junit XML arrives as a blob at exit, and partial lines are common at chunk boundaries. The adapter accumulates bytes, finds record boundaries, and emits events as records are recognized.

#### `onExit(status: ExitStatus): TaskEvent[]`

Called once after the final ProcessSpec exits (or after an abort). The adapter may flush any remaining parser state and emit a terminal `finished` event.

```ts
interface ExitStatus {
  taskId: string;
  code: number | null;          // null if killed by signal
  signal?: string;
  aborted: boolean;
}
```

---

### TaskEvent union

All structured output from adapters flows as `TaskEvent`s. The core routes events to the appropriate UI panel.

```ts
type TaskEvent =
  | { kind: "test";       taskId: string; id: string; parentId?: string;
      state: "running"|"passed"|"failed"|"skipped"|"errored";
      duration?: number;        // ms
      diff?: { expected: string; actual: string };
      output?: string; }        // per-test captured output

  | { kind: "diagnostic"; taskId: string;
      file: string;             // target-space path
      range: { start: {line:number;col:number}; end: {line:number;col:number} };
      severity: "error"|"warning"|"info"|"hint";
      message: string;
      code?: string; }          // reuses the LSP squiggle surface

  | { kind: "log";        taskId: string; level: "info"|"warn"|"error"; message: string; }
  | { kind: "output";     taskId: string; source: "stdout"|"stderr"; text: string; }
  | { kind: "progress";   taskId: string; done: number; total?: number; label?: string; }
  | { kind: "finished";   taskId: string;
      outcome: "success"|"failure"|"cancelled"|"error";
      code: number | null;
      summary?: string; }
```

Key UI mappings:

| Event | Drives |
|---|---|
| `test` | Live test tree; pass/fail/skip; per-test assertion diff; per-test captured output |
| `diagnostic` | Reuses the LSP squiggle surface — a compile error from `cargo test` looks identical to a rust-analyzer diagnostic |
| `log` / `output` | Run/test console |
| `progress` | Progress bar |
| `finished` | Terminal summary card; closes the active task |

**A test failure is a `finished{outcome:"failure"}` task with `test{state:"failed"}` events. It is not a `SapError`.** `SapError` means the adapter or toolchain could not do its job at all.

---

### Contract 5: Error model

```ts
type SapError =
  | { code: "TOOLCHAIN_MISSING"; tool: string; hint?: string }
        // core probes `<command> --version` in env on first use; special UI path
        // offers install guidance or points at required extension
  | { code: "CONFIG_INVALID";    detail: string; source?: "sindri.toml"|"local.toml" }
        // bad adapter config; points at the manifest line where possible
  | { code: "DISCOVERY_FAILED";  reason: string; raw?: string }
        // probe timed out / unexpected output / empty results
        // does NOT propagate to sibling toolchains
  | { code: "SPAWN_FAILED";      detail: string }
        // environment down, bad cwd, missing binary
  | { code: "PLAN_ERROR";        detail: string }
        // adapter threw during plan() or returned invalid ProcessSpec
```

Two invariants enforced by the core:

1. **Errors are per-toolchain, never per-project.** A missing Java toolchain must not degrade the Rust toolchain in the same polyglot workspace. Each `[toolchains.<name>]` binding has independent error state.
2. **Timeouts and output caps are core responsibilities.** `host.exec` calls have a hard timeout (default 30s, override in manifest). Streaming tasks have a maximum output buffer (default 16 MB) after which the core emits `SPAWN_FAILED` with a truncation note rather than OOM.

---

### Contract 6: Debug handoff (DAP bridge)

SAP does not debug. When `capabilities.debug: true`, the adapter exposes one additional function:

```ts
debugConfig(target: RunTarget, rootPath: string): DapLaunchConfig
```

Returns a DAP launch request that the language pack's DAP adapter consumes. Run-target knowledge lives in SAP; debug execution lives in DAP (ADR-0005). The core calls this function when the user invokes "Debug" on a SAP-discovered run target, then hands the config to the registered DAP adapter.

---

### Lifecycle: resident adapter, ephemeral tasks

| Layer | Lifetime | Analogy |
|---|---|---|
| Adapter handler | Resident in JS host, activated lazily on first use of a matching `[toolchains.*]`. Lives until extension deactivation. | LSP |
| Task process | One per run/test invocation. Spawned and reaped by the core. No daemon assumed. | DAP adapter |

**Watch mode**: a task whose final `ProcessSpec` does not exit (e.g. `cargo watch`, `vitest --watch`). The `taskId` persists across re-runs; `TaskEvent`s carry a `generation` counter so the UI resets the test tree each pass while preserving history.

**Cancellation**: always owned by the core. `cancelTask(taskId)` → SIGTERM → (timeout) → SIGKILL to the process group. The core synthesizes a terminal `onExit({aborted:true})` call to the adapter so it can emit a clean `finished{outcome:"cancelled"}` even if the tool was mid-output.

**Activation**: only adapters referenced by `[toolchains.*]` entries in the active project are activated. An adapter for `sindri.adapter.gradle` in an npm-only project never starts.

---

### The built-in `shell` adapter

The sole adapter that accepts a raw command string rather than a structured `argv`. Used exclusively by `[run.<name>]` entries that specify `adapter = "shell"` in `sindri.toml`. It wraps the command as `["sh", "-c", command]` and emits only `output` and `finished` events (no test tree, no diagnostics). This is the deliberate escape hatch for arbitrary scripts — not a first-class run mechanism.

---

### Day-one adapters

Per ADR-0013, these ship bundled with their respective language packs:

| Adapter ID | Language pack | Source of structured output |
|---|---|---|
| `sindri.adapter.cargo` | `sindri.lang.rust` | `--message-format=json` + nextest `libtest-json` |
| `sindri.adapter.maven` | `sindri.lang.java` | Surefire JSON reporter |
| `sindri.adapter.gradle` | `sindri.lang.java` | Gradle Test XML → parsed |
| `sindri.adapter.pytest` | `sindri.lang.python` | `pytest-json-report` plugin |
| `sindri.adapter.uv` | `sindri.lang.python` | wraps pytest via uv; same output |
| `sindri.adapter.npm` | `sindri.lang.web` | `scripts` from `package.json`; no test semantics |
| `sindri.adapter.vitest` | `sindri.lang.web` | `--reporter=json` |
| `shell` | built-in | raw output only |

## Consequences

- Adapter authors write **four functions** (`discover`, `plan`, `onOutput`, `onExit`) plus an optional `debugConfig`. No OS access; no spawning; no path concerns. The surface is small enough to keep high quality across day-one adapters.
- The "thin launcher+parser" shape means adapters are trivially unit-testable: feed a mock `host`, call `plan()`, assert `ProcessSpec`; feed raw byte sequences to `onOutput`, assert `TaskEvent[]`.
- **Per-ecosystem bespoke work is real.** ADR-0005 acknowledged this honestly: there is no industry-standard test protocol. Each `onOutput` parser is a per-ecosystem implementation. The structured JSON modes (`--message-format=json`, `--reporter=json`, `pytest-json-report`) minimize this, but it is non-zero effort per adapter.
- The `diagnostic` event reusing the LSP squiggle surface is a meaningful policy: a compile error surfaced during `cargo test` should look and behave identically to one surfaced by rust-analyzer. This requires the editor's diagnostic model to accept events from both LSP and SAP without preferring one source.
- **Watch mode** and **cancellation** have correctness requirements on the core side: process-group kill, `generation` counter propagation, and synthesized `onExit` on abort. These are core obligations, not adapter obligations.
- The JS extension host runtime (QuickJS vs Deno core) is still a deferred spike (ADR-0006). SAP defines what the host must expose to adapters; the runtime decision determines what is available to adapter authors beyond the explicit `host.*` API (Node-compat, fetch, etc.). That spike should be the next design task.

## See also

- [ADR-0005](0005-builtin-ide-frameworks.md) — protocol hosting strategy; SAP in context of LSP/DAP/Tree-sitter
- [ADR-0006](0006-extension-api-from-day-one.md) — JS extension host; adapters as dogfooded first-party extensions
- [ADR-0009](0009-remote-execution-environments.md) — `Environment` trait; why core owns spawning
- [ADR-0012](0012-project-file-format.md) — `[toolchains.*]` bindings; adapter IDs in `sindri.toml`
- [ADR-0013](0013-product-identity-and-polyglot-thesis.md) — day-one language pack table; polyglot-first error isolation requirement
