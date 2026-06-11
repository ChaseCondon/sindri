# ADR-0010: Dockable, movable panel layout (JetBrains-style)

- Status: Accepted
- Date: 2026-06-01

## Context

A core part of the "JetBrains-grade UX" promise is a **flexible workspace layout**: not VSCode's single activity bar + one primary sidebar, but **two sidebars** and dock regions on all four edges, where any tool window (file tree, search, run, test, debug, terminal, problems, …) can be **moved between left / right / top / bottom docks or torn off into a floating window**, and the layout is remembered.

This is significant UI engineering, and — critically — it interacts with the extension API: third parties (and our own dogfooded first-party features, ADR-0006) must be able to contribute tool windows into this layout.

## Decision

1. **A first-class layout engine** manages dock areas: a primary and secondary **left** sidebar, a primary and secondary **right** sidebar, a **bottom** dock, a **top** dock, and the central editor area. Tool windows are draggable between any dock and can **detach into floating OS windows**.
2. **Tool windows are registered, not hard-coded.** A tool window declares an id, title, icon, and a *preferred* dock; the user can move it anywhere. First-party panels register through the **same public API** exposed to extensions (ADR-0006) — if our own file tree can't be expressed as a contributed tool window, the API is wrong.
3. **Layout is persisted per workspace** (and sensibly defaulted), including dock placement, sizes, visibility, and floating-window geometry.
4. Built on SolidJS (ADR-0004). Drag/drop, splitters, and float/dock transitions are bespoke — no off-the-shelf component delivers this, consistent with ADR-0005's note that polish is product work.

## Consequences

- The shell's component tree is organized around dock regions from early on, not retrofitted — a window is "docks + a central editor group," not "a sidebar + editor."
- Floating windows mean a tool window must render correctly in a separate Tauri window; state lives in a shared store the float subscribes to, not in the dock's DOM subtree.
- The tool-window contribution API is part of the day-one extension surface, raising the bar for what v0's API must express.
- This is a large, ongoing UI investment. v0 can ship a fixed two-sidebar + bottom-dock layout and add free movement/floating incrementally — but the *registration model and store* are built correctly from the start so movement is additive, not a rewrite.
