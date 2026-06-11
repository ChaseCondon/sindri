# ADR-0021: Settings surface — core modal overlay over merged plugin config

- Status: Accepted
- Date: 2026-06-03
- Extends: [ADR-0015](0015-js-extension-host-runtime.md), [ADR-0019](0019-theme-and-icon-system.md), [ADR-0020](0020-extension-distribution-and-marketplace.md)
- Relates to: [ADR-0018](0018-split-panes-docking-floating.md) — floating-window deferral motivates "not floating yet"

## Context

Sindri needs a settings/preferences surface — the foundation for editor prefs, workspace-folder persistence, keybindings, and the marketplace's "configured repos" list. Two questions: **where does it render**, and **where does its content come from**.

The theme/icon toggles currently live in the status bar (`src/workbench/ThemeToggle.tsx`) with a standing TODO to move into Settings — they are the first real settings section and the first consumer.

## Decision

### 1. Settings is **core chrome**, not a plugin

Consistent with the core/plugin boundary in [ADR-0020 §1](0020-extension-distribution-and-marketplace.md): the settings *shell* is privileged workbench chrome. Its *content* is a **merged schema** aggregated from each installed plugin's `contributes.configuration` (the `sindri.workspace.configuration` API, ADR-0015 §4) plus core's own sections. Core renders; plugins supply schema — no private shortcut, dogfood rule (ADR-0006) intact.

### 2. Surface: a **modal overlay** (not floating, not docked — for now)

Settings opens as a centered **modal overlay** over the workbench.

- **Not floating.** Floating windows are ADR-0018 v0.3 and **unbuilt** (the hard cross-window-bus problem). Settings must not depend on it. If/when v0.3 lands, a "pop out" affordance can promote the overlay to a float for free.
- **Not a dock panel.** Settings is a full-surface, focused experience, not a narrow always-on rail.

The overlay reuses existing chrome styling/tokens (ADR-0019) and traps focus while open.

### 3. Content model: sections from a merged registry

```ts
interface SettingsSection {
  id: string;                 // "editor", "appearance", "extensions.repos", "ext.<id>"
  title: string;
  source: "core" | string;    // "core" or the contributing extension id
  schema: ConfigSchema;       // fields → types/defaults; rendered generically
}
```

- A `settings` registry mirrors the `layout`/`theme` registry pattern (`createStore`), populated by core sections + plugin `contributes.configuration`.
- Values persist to `localStorage` now (key `sindri:settings`); workspace-scoped values move to `sindri.toml` / `.sindri/` later (ADR-0012) without changing the UI.
- **First sections:** *Appearance* (migrate the status-bar theme/icon toggles here) and *Extensions → Repositories* (the configured git registries from ADR-0020).

## Consequences

- Settings ships without waiting on floating windows or the QuickJS host; the Appearance section is fully functional today (themes/icons are data, ADR-0019).
- The merged-schema model means a third-party plugin's settings appear automatically the day the host can read its `contributes.configuration` — same dogfood payoff as the rest of the system.
- Modal-first is a deliberate downgrade from the requested floating window; it is promotable to a float later at low cost.

### Deferred

- Generic schema→form renderer breadth (enums, nested objects, validation).
- Keybindings editor (its own surface later).
- Workspace vs. user scope resolution + precedence (lands with `sindri.toml` settings).

## See also

- [ADR-0020](0020-extension-distribution-and-marketplace.md) — core/plugin boundary; the repos this surface configures
- [ADR-0019](0019-theme-and-icon-system.md) — the theme/icon toggles that become the first section
- [ADR-0015](0015-js-extension-host-runtime.md) — `contributes.configuration` source of plugin sections
