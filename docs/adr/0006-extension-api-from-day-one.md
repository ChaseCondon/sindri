# ADR-0006: Extension API from day one (dogfooded JS host)

- Status: Accepted
- Date: 2026-06-01
- Extended by: [ADR-0013](0013-product-identity-and-polyglot-thesis.md)

## Context

"Extensible from day one" is a requirement, and there's one design rule that separates actually-extensible editors from extensible-in-theory ones: **build your own first-party features on top of the same extension API you expose to others.** VSCode's durability comes largely from this dogfooding. Bolt extensibility on later and you discover your API can't express the things your own UI quietly needed.

Plugin runtime options:

- **JS extension host** (separate process, JSON-RPC) — the VSCode model. Largest possible author ecosystem, easiest DX, natural fit for a web UI. Embed a lite JS runtime (QuickJS or Deno core) to stay lightweight.
- **WASM/WASI** — the Zed/Lapce model. Sandboxed, polyglot, natural for a *native* UI, but author DX is rougher today.

## Decision

Ship a stable **extension API in v0**, exposed to a **JS extension host** running in a separate process over JSON-RPC (embedded QuickJS or Deno core — final choice deferred to a spike, but JS-over-RPC is decided).

**Dogfooding is mandatory, and total:** every wrapper, adapter, runner, language pack, and IDE panel ships as an extension on the public API — no private shortcuts, no internal channels the extension API cannot express. The day-one language packs (`sindri.lang.rust`, `sindri.lang.java`, `sindri.lang.python`, `sindri.lang.web`) are the forcing function: they must be real extensions, not special-cased internals. The API is not "done" until our own panels and language packs are built on it. See [ADR-0013](0013-product-identity-and-polyglot-thesis.md) for the full day-one extension set.

## Consequences

- A web UI + JS host means extension authors stay in one language/ecosystem — lowest barrier, biggest potential community.
- Separate-process host keeps a misbehaving extension from freezing the editor and gives us a clean security/perf boundary.
- The dogfooding rule slows v0 slightly (we can't take private shortcuts in first-party features) but is the only way the API is real.
- WASM/WASI is not rejected forever — it could be added as a second host later for sandboxed, polyglot plugins. JS-first is the call for reach and DX now.
- Deferred to a spike: QuickJS vs Deno core (size vs. capability/Node-compat), and the exact API surface + event-bus shape.
