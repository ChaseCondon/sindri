# ADR-0011: Inline completion + suggestions — the one day-one AI, as a provider

- Status: Accepted
- Date: 2026-06-01
- Relates to: [ADR-0002](0002-human-first-not-ai-native.md), [ADR-0006](0006-extension-api-from-day-one.md)

## Context

Two distinct features are easy to conflate:

- **The suggestions window** — the completion popup (the list that appears as you type). This is mostly *not* AI: it's driven by LSP completions, buffer words, and snippets. It's table-stakes editor UX.
- **Inline completion ("ghost text")** — greyed-out multi-token text predicted ahead of the cursor, accepted with Tab. This is the Copilot/Cursor-style feature, and the *one* AI capability we want from day one.

There's an apparent tension with ADR-0002 ("human-first, not AI-native"). We resolve it explicitly here rather than letting it sit ambiguous.

## Decision

1. **The suggestions window is a core, AI-free editor feature.** Built on CM6's completion system, fed by LSP/snippets/buffer sources. Always present; no AI involved.

2. **Inline completion is a *provider-based* feature, and AI is one provider among several.** We define an **`InlineCompletionProvider` interface** — given context (prefix, file, cursor), return a candidate completion. Providers can be:
   - non-AI (LSP-driven full-line/next-token, smart snippets), and
   - AI-driven (local or cloud model).

   The *editor* owns the ghost-text rendering and accept/dismiss UX; providers only supply candidates. The UI doesn't know or care whether a suggestion came from an LLM.

3. **This honors ADR-0002, and is in fact its first proof.** Per ADR-0002, AI ships as *just another extension on the public API* — never a privileged core subsystem. The AI inline-completion provider is exactly that: it registers through the same provider API a third party would use (ADR-0006 dogfooding). Inline completion as a *mechanism* has zero AI dependency; remove every AI provider and inline completion still works (LSP-driven), the suggestions window still works, and nothing else in the editor notices.

4. **Defaults respect the human-first promise.** The AI provider is opt-in and clearly toggleable. The editor is fully functional, and feels complete, with no AI provider enabled. AI never blocks, never auto-acts beyond rendering a dismissible ghost suggestion, and never becomes the headline.

## Consequences

- We get the day-one AI the product wants (inline ghost-text completion) **without** violating "human-first": it's a provider plugged into a generic seam, not a core dependency. This is the cleanest possible reconciliation and validates the ADR-0002 architecture early.
- The `InlineCompletionProvider` and the completion-source APIs become part of the day-one extension surface (ADR-0006) — others can ship their own inline-completion engines.
- Latency discipline: inline completion is async and must never block typing or the suggestions window. Debounce, cancel stale requests, render when ready.
- Provider/runtime choice for the AI backend (local model vs. cloud, which model) is deferred — the interface is what we commit to now, not the backend.
