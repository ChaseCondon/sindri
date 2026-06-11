# ADR-0026: `sindri.ui` panel & UI surface API — declarative APIs + webview escape hatch; surface taxonomy (A/B/C)

- **Status:** Revised — 2026-06-09 · original VNode/message-passing decision superseded by addendum below
- **Date:** 2026-06-09
- **Closes deferral in:** [ADR-0015](0015-js-extension-host-runtime.md) (`sindri.window` / iframe escape hatch) · defines the shape [ADR-0022](0022-sidebar-panels-as-extensions.md) proposed
- **Follows the pattern of:** [ADR-0024](0024-editor-decorations-api.md) (data, not code, crosses the boundary)
- **Constrained by:** [ADR-0025](0025-js-extension-host-deno-v8.md) (per-isolate, off UI thread, no DOM), [ADR-0010](0010-dockable-panel-layout.md) / [ADR-0018](0018-split-panes-docking-floating.md) (dock/float layout), [ADR-0004](0004-frontend-solidjs.md) (SolidJS)
- **Reserves seams for:** [ADR-0028](0028-custom-editor-api.md) (surface B — custom editors), [ADR-0029](0029-editor-overlay-api.md) (surface C — overlays)
- **Superseded by addendum:** the VNode vocabulary model (original §3) — see [Addendum](#addendum-2026-06-09--vnode-model-reversed)

---

## Context

ADR-0022 decided that every sidebar panel except Explorer / Terminal / Output is **extension-contributed** via `sindri.ui.registerPanel(...)`. It is a prerequisite for the test runner, search, SCM, problems, minimap — every panel on the roadmap. ADR-0022 sketched the call but **deferred the rendering mechanism**, and the signature it sketched —

```ts
sindri.ui.registerPanel({ /* … */ render(container) { /* mount your UI */ } });   // ADR-0022 §2
```

— assumes the extension receives a live DOM `container`. **That signature is not implementable under the host architecture**, and correcting it is the substance of this ADR.

### The constraint that shapes everything (same boundary as ADR-0024)

The extension host is a **Deno/V8 per-isolate runtime running off the UI thread, in the Rust process, with no DOM** (ADR-0025 §2; ADR-0015 §4: *"view-model contributions only — no DOM access"*). CodeMirror and the workbench live in the **SolidJS webview**, a separate realm reached only over JSON-RPC / Tauri IPC.

> **An extension can never hand a live DOM node, component, or closure to a panel.** The object can't cross the process boundary, and the host has no DOM to build it in.

ADR-0024 hit this exact wall for editor decorations and resolved it: *"ship decoration data, not code."* A panel is the same problem one notch richer. The same spine applies.

### The three options on the table

1. **DOM injection** — the extension produces DOM / a component and the webview mounts it.
2. **Webview (iframe)** — each panel is a sandboxed iframe; extension UI runs as web code inside, bridged by `postMessage`.
3. **Narrow declarative APIs** — the host owns rendering; the extension supplies data via named API calls (`registerTreeView`, `createStatusBarItem`).

---

## Decision

**Adopt a two-tier hybrid. Both tiers are available to first- and third-party extensions (dogfood preserved). Both land Phase 1.**

1. **Tier 1 — Declarative APIs:** narrow, named contracts (VSCode-shaped, independently written) that the host renders consistently — `registerTreeView`, `createStatusBarItem` (with hover), `showQuickPick`/`createQuickPick`.
2. **Tier 2 — Webview escape hatch:** `registerWebviewPanel` — the extension ships any HTML/CSS/JS; the host sandboxes it in a `null`-origin iframe and injects theme tokens as CSS custom properties.

**Reject DOM injection** (same as the original analysis — architecturally unavailable).

**VNode vocabulary (original §3 of this ADR) reversed** — see [Addendum](#addendum-2026-06-09--vnode-model-reversed).

### §0. Why not DOM injection

| Option | Crash isolation | Security surface | Fits the no-DOM, cross-process isolate? | Verdict |
|---|---|---|---|---|
| **DOM injection** | ❌ extension UI runs in UI realm — hang freezes editor; defeats ADR-0025 isolation | ❌ ambient DOM + IPC; nothing to sandbox from; breaks when community extensions exist | ❌ **impossible** — no DOM in host; a node/closure cannot cross the process boundary | **Rejected** |
| **Webview (iframe)** | ✅ own realm, can't hang main thread | ⚠️ real origin sandbox; opens postMessage/network surface | ✅ **fits** — extension logic stays in V8 isolate; iframe is pure render target | ✅ **Tier 2** |
| **Declarative APIs** | ✅ isolate is already the boundary | ✅ data-only: no DOM, no origin, strictly less surface than today | ✅ **exact mirror of ADR-0024** — one vetted renderer per widget type | ✅ **Tier 1 (primary)** |

DOM injection is not "worse," it is *architecturally unavailable* — it presumes the extension shares a realm with the editor, which ADR-0025 spent its entire rationale separating.

### §1. UI surface taxonomy

Before specifying the APIs it helps to name the surfaces an extension can contribute:

| Surface | Label | What | Examples |
|---|---|---|---|
| Tool-window / dock panel | **A** | Resizable pane in sidebar/bottom dock (ADR-0010/0018) | Test runner, SCM, search, commit-streak heatmap |
| Editor-area / custom editor | **B** | Takes over the editor area for a specific file type | Image viewer, markdown preview, CSV grid (`sindri-csv-grid`) |
| Editor overlay / chrome | **C** | Decorates *within* the editor surface — tied to document coordinates | Minimap, git blame, TODO highlight, color swatches (`sindri-color-swatches`) |
| Status-bar / hover items | — | Chips in the status bar, rich hover tooltip | Commit-streak chip, language mode |

> **Minimap is category C** (core-rendered overlay), **not** a surface A panel. It needs direct access to doc text, syntax tree, viewport, and scroll — the decoration `ViewPlugin` path (ADR-0024) is the right vehicle, not a panel API. A third-party pixel surface that *genuinely* can't use Tier 1 is the first real driver for the Tier 2 webview.
>
> **Surface B** (`registerEditor`) and **surface C** (`registerOverlay`) are reserved seams specified in [ADR-0028](0028-custom-editor-api.md) and [ADR-0029](0029-editor-overlay-api.md).

### §2. Model A — bundled native panels (unchanged)

First-party panels whose `id` resolves to a SolidJS `Component` **compiled into core**. This is literally what `builtins.ts` does now (`render: FileExplorer`, `render: TerminalPanel`). Full SolidJS expressiveness, zero IPC, **first-party only**.

- **Explorer, Terminal, Output** stay Model A permanently (ADR-0022 §1 — core chrome).
- **Search, SCM, Test, Debug, Problems, Extensions** are Model A *transitionally*, migrating to Tier 1 as real extension implementations ship (ADR-0022 §3).

### §3. Tier 1 — Declarative APIs

The primary model for surface A panels is a set of **narrow, named API functions** modeled on VSCode's contribution points, written as Sindri's own type definitions (no `vscode.d.ts` prose; no trademark use):

```ts
namespace sindri.ui {
  // Surface A — tool-window panel backed by a tree view
  function registerTreeView(
    id: string,
    options: { title: string; icon: string; defaultDock: DockId },
    provider: TreeViewProvider,
  ): TreeView;

  // Status-bar chip
  function createStatusBarItem(options?: StatusBarItemOptions): StatusBarItem;
  // StatusBarItemOptions: { alignment?: "left"|"right"; priority?: number }
  // StatusBarItem: { text; tooltip; command; show(); hide(); dispose() }

  // Quick-pick palette
  function showQuickPick(items: QuickPickItem[], options?: QuickPickOptions): Promise<QuickPickItem | undefined>;
  function createQuickPick<T extends QuickPickItem>(): QuickPick<T>;
}
```

The host renders all Tier 1 surfaces — tree rows, status-bar chips, quick-pick rows — using ADR-0019 design tokens. The extension supplies data and handles events; it never touches DOM.

```ts
interface TreeViewProvider<T = unknown> {
  getChildren(element?: T): T[] | Promise<T[]>;
  getTreeItem(element: T): TreeItem;
  onDidChangeTreeData?: Event<T | undefined>;   // optional; fires to trigger refresh
}
interface TreeItem {
  id?: string;
  label: string;
  description?: string;
  tooltip?: string;                    // v1: plain string; future: MarkdownString
  iconPath?: string;
  collapsibleState?: TreeItemCollapsibleState;  // None | Collapsed | Expanded
  command?: Command;                   // {title, command, arguments?}
  contextValue?: string;
}
```

Events and data cross the IPC boundary as JSON; handler names (not closures) are used for callbacks — same pattern as ADR-0024 decorations.

**StatusBarItem tooltip / hover**: `tooltip` is a plain string in v1; a future overload accepts a `MarkdownString` (inline markdown + code spans) for rich hover content — the overload is designed in now (the type union grows; the wire format is additive).

**Floatability**: Tier 1 tree-view panels satisfy ADR-0018's serializable-metadata requirement by construction — the view-model is JSON. They can float. Tier 2 webview panels cannot (see §4).

### §4. Tier 2 — `registerWebviewPanel` (webview escape hatch, Phase 1)

For surfaces the Tier 1 vocabulary genuinely cannot express — pixel-level canvas, interactive graphs, embedded web frameworks — the escape hatch is a **webview panel**: the extension supplies a complete HTML document, the host sandboxes it in a `null`-origin iframe, and theme tokens are injected as CSS custom properties.

```ts
namespace sindri.ui {
  // Surface A panel backed by a webview
  function registerWebviewPanel(
    contribution: { id: string; title: string; icon: string; defaultDock: DockId },
    provider: WebviewPanelProvider,
  ): WebviewPanel;
}

interface WebviewPanelProvider {
  getHtml(context: WebviewContext): string;      // extension returns the full HTML document
  onMessage?(msg: unknown): void;               // handle postMessage from the webview JS
}
interface WebviewContext {
  postMessage(msg: unknown): void;              // send a message into the webview
}
interface WebviewPanel {
  postMessage(msg: unknown): void;
  dispose(): void;
}
```

**Host injections** — before mounting, the host prepends a `<style>` block to the HTML `<head>`:

```css
:root {
  --sindri-bg:        /* panel background */;
  --sindri-fg:        /* primary text */;
  --sindri-accent:    /* accent / highlight */;
  --sindri-border:    /* border color */;
  --sindri-font-ui:   /* UI typeface */;
  --sindri-font-mono: /* monospace typeface */;
  /* … full ADR-0019 token set … */
}
```

The webview JS calls `acquireSindriApi()` (injected by the host) to get a `postMessage` handle and an `onMessage` listener. The extension isolate is the peer — messages flow extension ↔ core broker ↔ webview; the outer SolidJS window is not involved.

**Phase 1 phasing**: Trusted v1 extensions (first-party, all signed by us) run in the Deno/V8 isolate (ADR-0025) which is already isolated. The webview iframe is scoped to `null` origin; no credentials are shared. This is sufficient for first-party code. The full OS-process sandbox for *untrusted* community extensions is a Phase 7 "Extension trust & security hardening" step — it waits not because the webview is unsafe for trusted code today, but because the threat it guards against (untrusted community code) doesn't exist until the marketplace phase.

**Standing limit**: A webview panel **cannot float** to a separate OS window (ADR-0018 §4 — a populated iframe cannot cross an OS-window boundary). Tier 1 declarative panels can float.

### §5. `sindri-commit-streak` — the two-tier demonstration

This sample exercises both tiers in one extension. It is the **dogfood proof** for the hybrid model: Tier 1 for the status-bar chip, Tier 2 for the heatmap panel that the `tree` vocabulary cannot cheaply encode.

```ts
// sindri-extensions/sindri-commit-streak/index.ts
import * as sindri from "@sindri/api";

// ── Tier 1: status-bar chip ───────────────────────────────────────────────
const chip = sindri.ui.createStatusBarItem({ alignment: "right", priority: 90 });
chip.command = "sindri-commit-streak.show";

async function refreshStreak() {
  const { stdout } = await sindri.env.exec("git", ["log", "--format=%cd", "--date=short", "-n", "365"]);
  const streak = computeStreak(stdout.split("\n").filter(Boolean));
  chip.text = `🔥 ${streak}-day streak`;
  chip.tooltip = `${streak} consecutive days with commits — click for heatmap`;
  chip.show();
}

function computeStreak(dates: string[]): number {
  const set = new Set(dates);
  let streak = 0;
  const d = new Date();
  while (set.has(d.toISOString().slice(0, 10))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// ── Tier 2: heatmap webview panel ────────────────────────────────────────
let webviewPanel: sindri.ui.WebviewPanel | undefined;

const provider: sindri.ui.WebviewPanelProvider = {
  getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <style>
    body  { background:var(--sindri-bg); color:var(--sindri-fg);
            font-family:var(--sindri-font-ui); padding:16px; margin:0 }
    h3    { margin:0 0 12px; font-size:13px; opacity:.7 }
    .grid { display:grid; grid-template-columns:repeat(52,12px); gap:2px }
    .cell { width:12px; height:12px; border-radius:2px;
            background:var(--sindri-border); cursor:default }
  </style>
</head>
<body>
  <h3>Commit activity — last 52 weeks</h3>
  <div class="grid" id="g"></div>
  <script>
    const api = acquireSindriApi();
    api.onMessage(({ commits }) => {
      const g = document.getElementById('g');
      g.innerHTML = '';
      commits.forEach(({ date, count }) => {
        const d = document.createElement('div');
        d.className = 'cell';
        if (count > 0)
          d.style.background =
            \`color-mix(in srgb, var(--sindri-accent) \${Math.min(100, count * 25)}%, transparent)\`;
        d.title = \`\${date}: \${count} commit\${count !== 1 ? 's' : ''}\`;
        g.appendChild(d);
      });
    });
    api.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  },

  async onMessage(msg: { type: string }) {
    if (msg.type !== "ready") return;
    const { stdout } = await sindri.env.exec("git", ["log", "--format=%cd", "--date=short", "-n", "365"]);
    const counts = new Map<string, number>();
    for (const d of stdout.split("\n").filter(Boolean))
      counts.set(d, (counts.get(d) ?? 0) + 1);
    const commits: { date: string; count: number }[] = [];
    for (let i = 364; i >= 0; i--) {
      const dt = new Date();
      dt.setDate(dt.getDate() - i);
      const key = dt.toISOString().slice(0, 10);
      commits.push({ date: key, count: counts.get(key) ?? 0 });
    }
    webviewPanel?.postMessage({ commits });
  },
};

export function activate() {
  webviewPanel = sindri.ui.registerWebviewPanel(
    { id: "sindri.commit-streak", title: "Commit Streak", icon: "./icons/flame.svg", defaultDock: "right-bottom" },
    provider,
  );
  refreshStreak();
}
```

**Permissions required** (`manifest.json`):
```json
{
  "permissions": {
    "exec": { "binaries": ["git"] },
    "ui": true
  }
}
```

### §6. Floating-panel compatibility (ADR-0018 §4)

Tier 1 declarative panels compose with floating windows for free. ADR-0018 §4 requires that only serializable metadata crosses a window boundary — a `registerTreeView` provider's data *is* serializable; the floated window subscribes to the same provider events over the cross-window bus and renders with its own host component.

Tier 2 webview panels **cannot float** (a populated iframe cannot cross an OS-window boundary, per ADR-0018's boxed fact). This is a standing architectural limit, not a deferral.

### §7. API surface & permissions

```
sindri.ui   registerTreeView(id, options, provider): TreeView      ← gated by ui
            createStatusBarItem(options?): StatusBarItem            ← gated by ui
            showQuickPick / createQuickPick                        ← gated by ui
            registerWebviewPanel(contribution, provider): WebviewPanel  ← gated by ui (+ webview sub-cap)
```

- **`ui` permission** gates all of `sindri.ui` (slots into ADR-0015 §6 / ADR-0023 alongside `editor.mutate`). Declaring it injects the namespace; omitting it leaves it absent — deny by default.
- **`webview` sub-capability** (within `ui`) may be separated later if the install-dialog needs to call out iframe content specifically; for now `"ui": true` covers both tiers.
- **`sindri.ui` namespace** is canonical (ADR-0022, this ADR). **Supersedes the `sindri.window` label** floated in ADR-0015 §4.

---

## Consequences

### What changes

- **`contributes.panels`** removed in favour of `contributes.treeViews`, `contributes.webviewPanels` in `ExtensionManifest` ([`manifest.ts`](../../src/extensions/manifest.ts)) — non-breaking (omitting them is valid), as ADR-0022 §Consequences foresaw.
- **Tier 1 renderers**: `<TreeViewHost>` SolidJS component + the data bridge (JSON-RPC op for `getChildren`/`getTreeItem`/event subscription); `StatusBarItem` plumbing in the status bar component; `QuickPick` overlay.
- **Tier 2 renderer**: iframe mount + theme token injection + `acquireSindriApi()` injected script + postMessage broker.
- **`@sindri/api`** gains `sindri.ui.registerTreeView`, `createStatusBarItem`, `showQuickPick`, `registerWebviewPanel` and their type definitions.
- **The VNode / `<PanelHost>` renderer** (original §3) is **not built** — the reversal eliminates that work item.
- **ADR-0022 §2's `render(container)` signature** is corrected by an addendum pointing here.

### What does NOT change

- The dock/layout model (ADR-0010 / ADR-0018), `layout.ts`, drag/float/show-hide, activity bar.
- Model A bundled panels (`builtins.ts`) — Explorer/Terminal/Output stay Model A permanently.
- The ADR-0025 isolation model, event bus, and `sindri.env` funnel.

### Costs accepted

- **Tier 1 is less expressive than a full widget vocabulary** — a tree, chips, and a quick-pick cover the real day-one cases. Extend by adding API surface (named functions), not by growing a VNode union.
- **Tier 2 is a real web surface** — postMessage, fetch (if `net` is granted), navigation. The `null`-origin sandbox and CSP are the first line; the OS sandbox (Phase 7) hardens further for untrusted code.
- **Webview panels can't float** — accepted; the constraint is architectural, not laziness.

### Deferred

- **`MarkdownString` hover on StatusBarItem** — overload reserved; plain string in v1.
- **Context menus on tree-view rows** — `contextValue` is in `TreeItem` now; the menu registration API is deferred.
- **Surface B (`registerEditor`) and surface C (`registerOverlay`)** — stub seams in ADR-0028 / ADR-0029.
- **OS sandbox hardening for untrusted webview content** — Phase 7 "Extension trust & security hardening".
- **`net` permission for webview panels** — specified alongside ADR-0025 §4 trust tier.

---

## Addendum (2026-06-09) — VNode model reversed

### What was decided in the original ADR-0026

The original Decision section (§3) adopted a **VNode vocabulary** as the primary extension UI model: a discriminated-union serializable VDOM (`{ t: "tree" }`, `{ t: "button" }`, `{ t: "text" }`, …) sent over IPC; a single generic `<PanelHost>` SolidJS component reconciling successive trees.

### Why it is reversed

**VNode vocabulary is an invented DSL, not a familiar contract.** The goal of the API is for extension authors to drop in and be productive without learning a new widget grammar. The VSCode-shaped declarative APIs (`registerTreeView`, `createStatusBarItem`, `showQuickPick`) are already in the muscle memory of the extension ecosystem. Writing our own type definitions for the same *shape* (without copying VSCode's prose or trademarks) gives us the benefit of familiarity without the copyright risk.

**VNode generalises to nothing extra the webview doesn't already cover better.** The use cases for a VNode vocabulary beyond what `registerTreeView` + `createStatusBarItem` covers are precisely the use cases (pixel surfaces, arbitrary frameworks, canvas) that the webview tier covers more honestly. VNode would add an intermediate tier that's neither as fast as a real DOM nor as expressive as HTML.

**Both tiers land Phase 1.** The original §4 deferred the webview ("reserved escape hatch — gated on ADR-0025 §4 trust/process tier"). That gating was based on the assumption that the sandbox was a prerequisite for safety. The correction: the sandbox protects against *untrusted* community code; v1 extensions are all first-party/trusted, so a `null`-origin iframe is safe to ship now. Only the OS-level sandbox hardening waits (Phase 7 "Extension trust & security hardening", tied to marketplace).

### Effect

- **`<PanelHost>` and the VNode reconciler are not built** — the work item is eliminated.
- **`sindri.ui.registerPanel(contribution, provider)` with a `render(): VNode` method** is not shipped — `registerTreeView` and `registerWebviewPanel` are the replacements.
- All other original decisions remain: Model A bundled panels, dock/layout model, floating constraints, permission gating, ADR-0022 `render(container)` correction, copyright guardrail.

---

## See also

- [ADR-0024](0024-editor-decorations-api.md) — Model A / Model B spine; the "data, not code" pattern this follows
- [ADR-0022](0022-sidebar-panels-as-extensions.md) — panels-as-extensions; `render(container)` corrected here
- [ADR-0025](0025-js-extension-host-deno-v8.md) — per-isolate, off-thread, no-DOM host; §4 trust tier the webview sandbox waits on
- [ADR-0015](0015-js-extension-host-runtime.md) — `sindri.*` surface, event bus, permissions
- [ADR-0018](0018-split-panes-docking-floating.md) — floating windows; why webview panels cannot float
- [ADR-0010](0010-dockable-panel-layout.md) — dock registry a contributed panel plugs into
- [ADR-0019](0019-theme-and-icon-system.md) — token CSS vars injected into webview panels
- [ADR-0027](0027-exec-capability-security.md) — exec security model; used by `sindri-commit-streak` sample
- [ADR-0028](0028-custom-editor-api.md) — surface B (custom editors) reserved seam
- [ADR-0029](0029-editor-overlay-api.md) — surface C (editor overlays) reserved seam
