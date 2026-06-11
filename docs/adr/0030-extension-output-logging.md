# ADR-0030: Extension output & logging — `sindri.output` API, console auto-capture, Extension Logs panel

- **Status:** Accepted — 2026-06-10
- **Follows from:** [ADR-0015](0015-js-extension-host-runtime.md) (sindri.* surface) · [ADR-0025](0025-js-extension-host-deno-v8.md) (Deno/V8 isolate) · [ADR-0026](0026-ui-panel-api.md) (Model A bundled panels)
- **Phase:** 1.5 — Extension author DX

---

## Context

Extension JS runs in a per-isolate V8 runtime off the UI thread (ADR-0025). `console.log` currently calls `Deno.core.print`, writing to the Sindri process stdout — invisible inside the UI. There is no way to observe extension behavior without an external terminal, which makes debugging (and demoing) impossible without attaching a separate process.

Two capabilities are missing:

1. **Visibility into extension runtime output** — `console.log/warn/error` should surface in the UI.
2. **Explicit named channels** — extensions that produce structured or domain-specific output (e.g. a language server adapter, a test runner) should be able to create named streams rather than interleaving everything into a single console log.

### Constraints

- Extension JS has no DOM access (ADR-0025 §2). All output crosses the IPC boundary via the existing `op_event_emit` / `EventTx` channel.
- Console must be auto-captured without changes to existing extension code. `sindri-now-playing` and `sindri-commit-streak` must log without modification.
- The Extension Logs panel must be distinct from the Output panel (which is reserved for build/task system output per ADR-0022).

---

## Decision

### §1. Two-layer output model

| Layer | How | Consumer |
|---|---|---|
| **Auto-capture** | Bootstrap overrides `console.{log,warn,error}` to emit `__sindri.output.line` via `op_event_emit`. Every extension gets a "Console" channel for free. | Any extension, no changes needed |
| **Explicit channels** | `sindri.output.createOutputChannel(name)` returns an `OutputChannel` for structured or named streams. | Extensions that opt in |

Both layers use the **same wire event and the same store**. A "Console" channel is just an `OutputChannel` whose name is `"Console"` and whose `channelId` is always `"console"` — it is implicitly created for every extension when that extension is registered by `activateExtensionWithManifest`.

### §2. Wire protocol

All output crosses IPC via a single event shape:

```
Event ID:  __sindri.output.line
Payload:   {
  extId:     string,          // extension manifest id, e.g. "sindri.commit-streak"
  channelId: string,          // "console" for auto-captured; user-chosen name for explicit channels
  level:     "log" | "warn" | "error" | "info",
  msg:       string,
  ts:        number           // Date.now() at emit time
}
```

Supporting events for channel lifecycle:

| Event | Payload | When |
|---|---|---|
| `__sindri.output.channelCreated` | `{ extId, channelId, name }` | `createOutputChannel(name)` called |
| `__sindri.output.channelClear` | `{ extId, channelId }` | `OutputChannel.clear()` |
| `__sindri.output.channelShow` | `{ extId, channelId }` | `OutputChannel.show()` |
| `__sindri.output.channelDisposed` | `{ extId, channelId }` | `OutputChannel.dispose()` |

The `"console"` channel never emits `channelCreated` — it is synthesised by the frontend store when the extension is registered (not from a runtime event).

### §3. Extension ID attribution

Each extension runtime must know its own `id` so console lines carry the correct `extId`. The mechanism:

`do_load_and_activate` injects a one-line script immediately before the bundle code runs:

```js
globalThis.__sindri_ext_id = "sindri.commit-streak";
```

The bootstrap's `console` override and `sindri.output` methods read `globalThis.__sindri_ext_id` at call time (not closure time), so they always have the correct value once the bundle is loaded.

The `ext_id` threads through the full activation chain:

```
activateExtensionWithManifest(bundlePath)   [activation.tsx — reads manifest.id]
  └─ activateExtension(bundlePath, extId)   [host.ts]
       └─ invoke("ext_activate", { bundlePath, extId })
            └─ ExtHost::activate(path, extId, env)   [Rust]
                 └─ ExtensionRuntime::load_and_activate(path, extId)
                      └─ do_load_and_activate: inject __sindri_ext_id script
```

`ext_id` is `Option<String>` at every layer; falls back to `"unknown"` in the bootstrap so pre-manifest activation paths (tests, direct `ext_activate` calls) still work.

### §4. `sindri.output` API

```ts
namespace sindri.output {
  /**
   * Create a named output channel. The channel appears in the Extension Logs
   * panel under the calling extension, alongside its Console channel.
   */
  function createOutputChannel(name: string): OutputChannel;
}

interface OutputChannel {
  /** Append text + newline. The new line is added to the panel immediately. */
  appendLine(value: string): void;

  /**
   * Append text without a trailing newline. Text accumulates in a per-channel
   * buffer; a complete line is committed (and displayed) whenever a '\n' is
   * encountered. Pending partial lines are flushed on dispose().
   */
  append(value: string): void;

  /** Clear all lines from this channel's log in the panel. */
  clear(): void;

  /** Focus the Extension Logs panel and select this channel. */
  show(): void;

  dispose(): void;
}
```

**Partial-line buffering** (`append` semantics): the frontend store holds a `pendingLine: string` per channel. Each `__sindri.output.line` event with `noNewline: true` appends to the pending buffer without committing. A subsequent line with `noNewline` absent (or false) flushes the pending buffer + appends the new content as a complete `LogLine`. This is opaque to the extension author — `appendLine` always produces one displayed line.

**Permissions:** `sindri.output` requires no manifest permission declaration. Logging is a basic developer right; restricting it would only harm DX. This follows the same logic as `console.log` in VS Code.

### §5. Extension Logs panel

A **Model A bundled panel** (ADR-0026 §2) — compiled into core, full SolidJS, registered in `builtins.ts`. Panel id: `sindri.extension-logs`. Default dock: `bottom`.

#### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Extension Logs                                            [Clear ×]  │
├─────────────────┬────────────────────────────────────────────────────┤
│ ▾ Other         │  sindri.commit-streak › Console          [Clear]  │
│   ▾ Commit S.   │                                                    │
│       ● Console │  10:23:45  LOG  streak computed: 7                │
│       ○ Streak  │  10:23:45  LOG  git log: 42 lines                 │
│   ▸ Now Playing │  10:23:46  WRN  no repo at /tmp — fallback        │
│ ▸ Tools (2)     │  10:23:47  ERR  TypeError: Cannot read prop 'x'   │
└─────────────────┴────────────────────────────────────────────────────┘
         ↕ draggable (Splitter)
```

**Left pane — channel tree:**
- Top level: **category headers** from `manifest.categories[0]`, collapsible (`▾`/`▸`). Collapsed header shows total unread count.
- Second level: **extension name** (from manifest), collapsible. Shows unread count badge when collapsed.
- Third level: **channel name** (`Console`, plus any explicit channels). Selectable; selected channel is highlighted (`●`/`○`).

**Right pane — log view:**
- Header: `extId › channelName` breadcrumb + per-channel **Clear** button.
- Log lines: `timestamp  LEVEL  message`. Timestamp is locale time (hh:mm:ss). Level badges: `LOG` (muted), `WRN` (amber), `ERR` (red), `INF` (blue).
- Auto-scroll to bottom on new lines; pauses auto-scroll if the user has manually scrolled up (standard terminal behaviour).

**Resizable split:** uses the existing `Splitter` component (horizontal axis). Left pane defaults to 180px, min 120px. Width is stored in local component state — not in the layout store (panel-internal geometry is not persisted across sessions in Phase 1).

**Unread counts:** increment when a new line arrives for a channel that is not currently selected. Reset to zero when the channel is selected. Counts propagate up: extension's unread = sum of its channels; category's unread = sum of its extensions.

### §6. Reactive store shape

```ts
// ext-logs-store.ts

interface LogLine {
  ts: number;
  level: "log" | "warn" | "error" | "info";
  msg: string;
}

interface LogChannel {
  channelId: string;    // "console" or user-chosen name
  name: string;         // display name
  lines: LogLine[];
  pending: string;      // partial-line buffer for append()
  unread: number;
}

interface ExtLogEntry {
  id: string;           // manifest id
  name: string;         // manifest name
  categories: string[]; // manifest categories
  channels: LogChannel[];
}

// Reactive: [store, setStore] = createStore<Record<extId, ExtLogEntry>>({})
// Selected: createSignal<{ extId: string; channelId: string } | null>(null)
// Show request: createSignal<{ extId: string; channelId: string } | null>(null)
```

---

## Consequences

### What changes

- **`SINDRI_BOOTSTRAP`** (`runtime.rs`): `console.{log,warn,error}` overridden to emit `__sindri.output.line`; `sindri.output` namespace added with `createOutputChannel`.
- **`Msg::LoadAndActivate`** (`runtime.rs`): gains `ext_id: Option<String>`; `do_load_and_activate` injects `__sindri_ext_id` script.
- **`ExtensionRuntime::load_and_activate`**, **`ExtHost::activate`** (`exthost/`): accept `ext_id: Option<&str>`.
- **`ext_activate` Tauri command** (`lib.rs`): gains `ext_id: Option<String>` parameter.
- **`activateExtension(bundlePath, extId?)`** (`host.ts`): extended signature.
- **`activateExtensionWithManifest`** (`activation.tsx`): passes `manifest?.id` to `activateExtension`; calls `registerOutputChannel(id, name, categories)` on the store.
- **New: `ext-logs-store.ts`** — reactive store as above.
- **New: `ExtensionLogsPanel.tsx`** — two-pane Model A panel.
- **`builtins.ts`** (or equivalent): registers `ExtensionLogsPanel` at `bottom` dock.
- **`@sindri/api` `index.d.ts`**: adds `SindriOutput` namespace and `OutputChannel` interface.

### What does NOT change

- The event bus (`op_event_emit` / `EventTx` / Tauri emit) — zero new ops; all output flows through the existing channel.
- Existing extension code — `console.log` calls in `sindri-now-playing` and `sindri-commit-streak` work without modification.
- `sindri.env`, `sindri.ui`, `sindri.events`, `sindri.commands` — unchanged.
- The Output panel (reserved for build/task system output) — not built here; stays placeholder.

### Costs accepted

- **One extra IPC round-trip per `console.log` call.** `op_event_emit` is fire-and-forget (synchronous op, unbounded channel). At typical extension log rates (< 100/s) this is negligible. High-frequency logging (hot loops) is an extension author problem, not a platform problem.
- **No structured object logging.** `console.log({ foo: "bar" })` serialises to `JSON.stringify` output. Structured log inspection (expandable object trees) is deferred.
- **Partial-line `append` flushed at dispose.** If an extension disposes an `OutputChannel` mid-line without a trailing `\n`, the partial line is flushed as-is. This is acceptable.

### Deferred

- **Structured / expandable object rendering** in the log panel (Phase 1.5d).
- **Log persistence** across restarts — logs are in-memory only for now.
- **`sindri.output.createOutputChannel` permission gate** — if a future threat model requires gating logging, add `"output"` as a sub-capability of `"sindri.output"`. For now: ungated.
- **Per-channel log-level filter** in the panel UI (Phase 1.5d).
- **Extension Logs panel left-pane width persisted across sessions** (Phase 1.5d).

---

## See also

- [ADR-0015](0015-js-extension-host-runtime.md) — original `sindri.*` surface sketch
- [ADR-0025](0025-js-extension-host-deno-v8.md) — Deno/V8 isolate; op_event_emit mechanism
- [ADR-0026](0026-ui-panel-api.md) — Model A panels; why this is Model A not extension-contributed
- [ADR-0027](0027-exec-capability-security.md) — permissions model; why `sindri.output` is ungated
