# ADR-0022: Sidebar panels as extensions — all panels except core three are extension-contributed

- Status: Accepted (2026-06-17, Phase 1 review) · **rendering mechanism defined by [ADR-0026](0026-ui-panel-api.md)**
- Date: 2026-06-04
- Extends: [ADR-0006](0006-dogfooded-js-extension-host.md), [ADR-0015](0015-js-extension-host-runtime.md), [ADR-0020](0020-extension-distribution-and-marketplace.md)

> **⚠️ Addendum (2026-06-09) — the `render(container)` signature in §2 is superseded by [ADR-0026](0026-ui-panel-api.md).**
> §2 sketched `render(container) { /* mount your UI */ }`, which assumes the extension receives a live DOM container. That is **not implementable**: the host is a Deno/V8 isolate off the UI thread with no DOM, and a DOM node/closure cannot cross the process boundary (ADR-0025 §2). ADR-0026 corrects this — panels ship a **serializable view-model** painted by one generic core `<PanelHost>` (Model B), with bundled native SolidJS components as the first-party in-process model (Model A) and an iframe escape hatch reserved. The `contributes.panels` field, the dock registry reuse, and the everything-is-an-extension intent of this ADR all stand.

> **⚠️ Addendum (2026-06-17) — status → Accepted (Phase 1 review).** `contributes.panels` + `sindri.ui.registerPanel` shipped on the Deno/V8 host. §3's transition plan is superseded on one point: the host arrived as **Deno/V8 ([ADR-0025](0025-js-extension-host-deno-v8.md))**, not QuickJS ([ADR-0015](0015-js-extension-host-runtime.md), itself superseded). Search/Git/Debug/Problems remain bundled placeholders in `builtins.ts` pending their feature phases — expected, not a regression. The everything-is-an-extension intent holds.

## Context

Sindri's founding principle (ADR-0006) is that **everything is an extension** — the IDE's own features dogfood the same API that third-party developers use. The current workbench has eight tool-window panels registered as hard-coded built-ins in `src/workbench/builtins.ts`:

| Panel | Current status |
| --- | --- |
| Explorer | Truly core — file system access, deeply coupled to CoreClient |
| Terminal | Truly core — shell integration |
| Output | Truly core — log stream from IDE subsystems |
| Search | Placeholder — should come from a `sindri.search` extension |
| Git / Source Control | Placeholder — should come from a `sindri.scm` extension |
| Debug | Placeholder — should come from a `sindri.debug` extension |
| Extensions | Placeholder — the marketplace panel itself |
| Problems | Placeholder — populated by LSP diagnostics; should come from language extensions |

The three "truly core" panels are special because they require host-level access that no extension API can reasonably mediate. Everything else is a policy choice, not an architectural requirement — and that policy should be "extension-contributed."

## Decision

### 1. Core panels (always bundled, not removable)

The following panels are **core chrome**, not extensions. They ship in `sindri-ide` itself and are never distributed via the marketplace:

- **Explorer** — file tree, workspace management, CoreClient seam
- **Terminal** — integrated shell (when extension host lands, this gets a `sindri.terminal` contribution wrapper, but remains bundled)
- **Output** — IDE-internal log stream; not meaningful as an extension

### 2. All other panels come from `contributes.panels`

Every other panel is contributed by an extension via a new `contributes.panels` field:

```ts
export interface PanelContribution {
  id: string;           // globally unique, e.g. "sindri.search"
  title: string;        // label shown in the activity bar tooltip + panel header
  icon: string;         // path to the SVG icon within the extension folder
  defaultSection: "left-top" | "left-bottom" | "right-top" | "right-bottom" | "bottom";
  // render() is called by the extension host; not in the manifest
}
```

The extension registers its panel with:
```ts
sindri.ui.registerPanel({
  id: "sindri.search",
  title: "Search",
  icon: "./icons/search.svg",
  defaultSection: "left-top",
  render(container) { /* mount your UI */ }
});
```

### 3. Placeholder panels transition plan

The eight current placeholder panels in `builtins.ts` will be **replaced progressively** as real extension-contributed implementations ship. In the interim they remain as placeholders to hold the activity bar slot. The transition is:

1. Explorer, Terminal, Output — remain bundled permanently
2. Search, Git, Debug, Problems, Extensions — migrate to first-party extensions in `sindri-ide/core-extensions/` once the extension host ships (QuickJS, ADR-0015)
3. Extensions (the marketplace panel) — ironic exception: it must be available before the extension host, so it stays bundled until the host is stable

### 4. Right-click activity bar — show/hide panels

Users can already right-click the activity bar to show or hide individual panels (implemented in `ActivityBar.tsx` via `hideToolWindow`/`showToolWindow` in `layout.ts`). The hidden state persists to localStorage. Hidden panels can be restored via the same right-click menu.

## Consequences

- Third-party extensions can register new sidebar panels — Git clients, database browsers, AI chat, etc.
- The `contributes.panels` field needs to be added to `ExtensionManifest` in `src/extensions/manifest.ts` and the JSON Schema.
- The manifest change is non-breaking — omitting `contributes.panels` is always valid.
- This ADR is **proposed**: the `contributes.panels` field is documented here but not yet wired. It becomes implementable once the QuickJS host (ADR-0015) ships.

## See also

- [ADR-0006](0006-dogfooded-js-extension-host.md) — everything-is-an-extension founding thesis
- [ADR-0015](0015-js-extension-host-runtime.md) — QuickJS host that makes `sindri.ui.registerPanel()` callable
- [ADR-0020](0020-extension-distribution-and-marketplace.md) — how panel extensions would be distributed
