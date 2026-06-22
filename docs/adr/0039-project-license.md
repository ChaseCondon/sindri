# ADR-0039: Project license — MIT OR Apache-2.0 (permissive, dual)

- Status: Accepted
- Date: 2026-06-17
- Context: surfaced by the [Phase 1 End-of-Phase Review](../reviews/phase-1-review.md) (finding A3-license) as an undocumented decision.

## Context

All three workspace crates (`sindri-app`, `sindri-core`, `sindri-cli`) declare `license = "MIT OR Apache-2.0"` in their `Cargo.toml`, but no ADR rationalized the choice — and the author's *global* default preference is AGPL v3. The Phase 1 review flagged this as a significant decision made by omission. The owner does not plan to monetize Sindri, which removes the usual commercial driver in either direction.

The competing pull is real and worth recording:

- **AGPL-3.0-or-later** (the considered alternative) maximizes openness protection — it would prevent proprietary forks and, via §13, closed re-hosting of the browser/PWA (ADR-0017) and remote-execution (ADR-0009) surfaces. The V8-isolate/IPC extension boundary (ADR-0025 §2) would have let third-party extensions stay independently licensed via a linking-style exception.
- **MIT OR Apache-2.0** maximizes *reuse* over *protection*.

## Decision

**Sindri's own code is licensed `MIT OR Apache-2.0` (permissive dual-license).** This overrides the author's global AGPL default for this project specifically.

Rationale:

1. **Rust-ecosystem convention.** Dual MIT/Apache-2.0 is the de-facto standard for Rust projects; it maximizes downstream compatibility and lets consumers pick whichever fits their stack (Apache's explicit patent grant or MIT's brevity).
2. **Reuse over copyleft, given no monetization.** Without a commercial motive, the priority is frictionless adoption, forking, and embedding — including by the extension ecosystem and by other tools — rather than enforcing source release on derivatives.
3. **No extension-boundary ambiguity.** Permissive licensing sidesteps the question of whether extensions linking the public `@sindri/api` are derivative works, so no linking exception is needed (it would have been required under AGPL/GPL).

## Consequences

- Anyone may fork, embed, re-host, or build on Sindri, including in proprietary products. This is accepted.
- Extensions carry their own licenses freely; bundled first-party language packs default to the same `MIT OR Apache-2.0`.
- The Cargo `license` fields are already correct — **no metadata change required.**
- Add canonical **`LICENSE-MIT`** and **`LICENSE-APACHE`** files at the repo root (dual-license convention). `LICENSE-MIT` is added with this ADR; `LICENSE-APACHE` carries the verbatim Apache-2.0 text.
- The global AGPL default still applies to *other* projects; this ADR is Sindri-scoped.

## See also

- [Phase 1 review §3](../reviews/phase-1-review.md) — the license analysis (incl. the AGPL alternative) that fed this decision.
- [ADR-0025](0025-js-extension-host-deno-v8.md) — the isolate/IPC extension boundary that made the licensing of extensions a non-issue under a permissive core.
</content>
