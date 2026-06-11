# ADR-0028: `sindri.ui.registerEditor` — custom editor surface (surface B)

- **Status:** Reserved — seam only; not yet designed
- **Date:** 2026-06-09
- **Extends:** [ADR-0026](0026-ui-panel-api.md) surface taxonomy (surface B = editor-area / custom editors)
- **Constrained by:** [ADR-0016](0016-editor-buffer-and-tab-model.md) (buffer/tab model), [ADR-0025](0025-js-extension-host-deno-v8.md) (no DOM in host)

---

## Context

ADR-0026 §1 defines **surface B** as the editor-area surface: an extension that, for a given file type or URI scheme, takes over the editor area and renders custom content rather than the standard CM6 text editor. First-party examples: image viewer, markdown preview, SQLite browser. Third-party example: `sindri-csv-grid`.

The API shape is reserved here as a named seam. The full decision — how the custom editor integrates with the tab model (ADR-0016), how it serializes state for float/restore (ADR-0018), whether it uses the Tier 1 declarative path or Tier 2 webview for its UI, and how undo/redo hooks in — is deferred until there is a concrete first-party use case driving the design.

---

## Reserved seam

```ts
// Placeholder — not the final API shape
namespace sindri.ui {
  function registerEditor(
    selector: { scheme?: string; language?: string; pattern?: string },
    provider: CustomEditorProvider,
  ): Disposable;
}
```

Expected implementation note: a custom editor will likely use the Tier 2 webview path (ADR-0026 §4) for pixel-level control (image viewer, CSV grid) or the Tier 1 declarative path for tree-structured content. The broker and `postMessage` bridge are shared infrastructure.

---

## See also

- [ADR-0026](0026-ui-panel-api.md) — surface taxonomy; Tier 1/2 UI model
- [ADR-0016](0016-editor-buffer-and-tab-model.md) — buffer/tab model the custom editor must integrate with
- [ADR-0029](0029-editor-overlay-api.md) — surface C (editor overlays) — the other reserved seam
