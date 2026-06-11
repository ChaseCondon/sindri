# ADR-0004: Frontend framework — SolidJS

- Status: Accepted
- Date: 2026-06-01

## Context

The frontend framework drives the IDE chrome — tabs, file tree, panels, command palette, status bar, and the run/test/debug UIs. It does **not** touch the editing hot path: CodeMirror 6 owns its own DOM subtree imperatively and bypasses framework reactivity entirely (ADR-0003). So framework choice is **irrelevant to editor latency** and should be made on developer experience and fit, not raw speed.

Candidates: React (heavier, coarse reactivity), Svelte 5 (runes → signal-style reactivity, bigger ecosystem, gentler curve), Solid (JSX + the finest-grained signals, surgical DOM updates, no component re-render). Svelte 5 and Solid have technically converged on the reactivity model; their raw performance is a wash for this workload.

## Decision

Use **SolidJS** for the IDE chrome, with our own CSS design system.

## Consequences

- An IDE shell is one of the rare app types that is genuinely state-heavy enough for fine-grained reactivity to pay off in both performance and code clarity — thousands of independent reactive cells (cursor positions, per-tree-node state, diagnostics, panel visibility, run/test status). Solid's model fits this exactly.
- We hand-build most distinctive panels regardless (a JetBrains-grade debugger view isn't off-the-shelf in any ecosystem), so Svelte's larger component-library advantage is muted.
- Cost accepted: smaller ecosystem than Svelte (~1.5M vs ~4M weekly downloads) and a less mature meta-framework story — but we don't need SolidStart; this is a desktop app, not an SSR web app.
- Build tooling: Vite. See ADR-0001/0007 stack notes.

## Addendum (2026-06-01): reaffirmed after direct Svelte 5 comparison

We revisited Solid vs. Svelte 5 explicitly (Svelte 5's runes have converged on the same signal model, so raw perf is a wash and irrelevant anyway — CM6 owns the hot path). Confirmed **SolidJS**. The deciding factor, beyond zero migration cost from the existing skeleton:

- **`createStore`'s fine-grained reactivity into deeply nested state** maps onto IDE state better than anything else available — a workspace tree where one node's dirty flag, diagnostics, or expansion state changes without re-running siblings or the whole tree. This is the rare app class where fine-grained reactivity is a structural win, not a micro-optimization, and it's why this *category* of app (editors/IDEs) trends Solid.
- Markup is pure TSX, giving full TypeScript in template expressions with no special tooling.

**Costs accepted (eyes open):** smaller component ecosystem than Svelte (we hand-build distinctive panels regardless, ADR-0005), and **Solid 2.0 is in progress** — we may face some API churn and should track its migration guide. Svelte's scoped CSS + SFC ergonomics and larger primitive ecosystem were the real draws the other way; we judged the IDE-state fit and TS experience to outweigh them.

Package manager / runner is **bun** (see README / docs/development.md) — orthogonal to this decision.
