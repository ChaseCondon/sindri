# ADR-0029: Editor overlay & widget API — surface C (extends ADR-0024)

- **Status:** Reserved — seam only; not yet designed
- **Date:** 2026-06-09
- **Extends:** [ADR-0024](0024-editor-decorations-api.md) (decoration API), [ADR-0026](0026-ui-panel-api.md) surface taxonomy (surface C = editor overlays)
- **Constrained by:** [ADR-0025](0025-js-extension-host-deno-v8.md) (no DOM in host), [ADR-0003](0003-editor-surface-cm6-plus-webgl2.md) (CM6 + WebGL2 render pipeline)

---

## Context

ADR-0026 §1 defines **surface C** as the editor overlay / chrome surface: features that decorate *within* the editor area, tied to document coordinates, rendered by the core pipeline. First-party examples: minimap, git blame gutter, TODO highlight. Third-party example: `sindri-color-swatches`.

ADR-0024 already defines the decoration API for simple marks and line decorations (Model A bundled, Model B host-supplied ranges). Surface C extends that into richer overlays — gutter widgets, inline annotations, viewport-spanning chrome — that need more than a CSS class on a range.

The minimap is the canonical category C feature. It is **core-rendered** (ADR-0026 §1, §5): it needs the doc text, syntax tree, viewport geometry, and scroll position that only a CM6 `ViewPlugin` can access efficiently. It is not a panel (surface A) and does not go through the message-passing panel API.

The full API design — how an extension contributes a `ViewPlugin`-equivalent from the V8 isolate (or whether overlays remain first-party-only), how gutter widgets hook in, and how surface C interacts with the WebGL2 render tier — is deferred until a concrete third-party overlay use case drives the shape.

---

## Reserved seam

Surface C is currently **first-party only**: overlays are CM6 `ViewPlugin` / `Decoration` extensions compiled into core (ADR-0024 Model A). The third-party path is acknowledged as a future need but not designed yet.

When designed, the API will live in `sindri.ui` (consistent with the surface taxonomy) and extend the ADR-0024 decoration model rather than replace it.

---

## See also

- [ADR-0024](0024-editor-decorations-api.md) — current decoration API (Model A/B) that surface C builds on
- [ADR-0026](0026-ui-panel-api.md) — surface taxonomy; minimap classified as category C
- [ADR-0003](0003-editor-surface-cm6-plus-webgl2.md) — CM6 + WebGL2 render pipeline surface C overlays must respect
- [ADR-0028](0028-custom-editor-api.md) — surface B (custom editors) — the other reserved seam
