# ADR-0002: Human-first, not AI-native

- Status: Accepted
- Date: 2026-06-01

## Context

The editor market is sprinting toward "agentic" — AI as the primary surface, the editor as scaffolding around a chat/agent loop. We believe this is both a product mistake for our audience and an underserved niche. There is real market signal (e.g. developers forking editors specifically to strip LLM integration, vendors overhauling terms of use around AI). Our target users are tired of AI being the center of gravity and want a tool that makes *the human* faster.

## Decision

The developer is the protagonist. **AI is an optional, secondary subsystem — never a core dependency, never the default mode, never the headline.** When AI is added, it ships as *just another extension* on the public extension API (ADR-0006), not as a privileged core subsystem.

## Consequences

- **Architectural rule:** no core feature may depend on an AI subsystem. If removing all AI code would break the file tree, search, run, test, or debug experience, we've violated this ADR.
- AI features, when they come, are gated, opt-in, and removable. A user who never enables them should never see them.
- This is a product-positioning ADR as much as a technical one: it's a promise to a specific audience. Breaking it is a strategic decision, not a refactor — hence it's recorded here.
- Trade-off accepted: we forgo the "AI-first" hype cycle and the users who want that. That's the point.
