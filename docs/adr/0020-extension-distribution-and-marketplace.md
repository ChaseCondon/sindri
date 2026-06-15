# ADR-0020: Extension distribution, manifest & marketplace (git-repo registries)

- Status: Accepted · §3 index format superseded by [ADR-0038](0038-manifest-type-and-id-resolution.md)
- Date: 2026-06-03
- Extends: [ADR-0006](0006-extension-api-from-day-one.md), [ADR-0013](0013-product-identity-and-polyglot-thesis.md), [ADR-0015](0015-js-extension-host-runtime.md), [ADR-0019](0019-theme-and-icon-system.md)
- Constrained by: [ADR-0017](0017-browser-pwa-target.md) — the core-transport seam applies to registry fetch

> **Addendum (2026-06-15, [ADR-0038](0038-manifest-type-and-id-resolution.md)):** the §3 flat folder-path index is replaced by a flat `entries: [{ id, path, type }]` list; manifests gain an authoritative `type` field; member/`extends` resolution is by id, not path-guessing.

## Context

ADR-0006/0013 lock "everything is an extension" and ADR-0015 defines the runtime + `sindri.*` API. ADR-0019 makes themes/icons extension-contributed data. What none of them define is **how an extension reaches a user's machine**: discovery, install, update, and the storefront. This ADR closes that gap and pins the manifest schema that the loader, the host, and the marketplace all read.

Three forces shape the design:

1. **No central app-store dependency.** Distribution must be open and self-hostable. Extensions live in **git repositories**; users add repos (we ship one central first-party repo) and the marketplace aggregates across all configured repos.
2. **The browser/PWA target cannot clone (ADR-0017).** Fetching extensions must go through a transport seam with a Tauri impl and a browser impl, exactly like `CoreClient`.
3. **One extension contributes many things.** A language pack (ADR-0013 `sindri.lang.rust`) is LSP + DAP + grammar + task adapters + an icon at once. The manifest must model a *set of contributions*, not a single "type".

## Decision

### 1. The core/plugin boundary (what "everything is a plugin" actually means)

"Everything is a plugin" governs **IDE capabilities**, not the framework that loads them. The privileged **core / workbench chrome** — extension host, marketplace client, registry fetch, settings store, dock/tabs/explorer — is **not** a sandboxed plugin and never will be. Making the loader an installable plugin is a bootstrap paradox (it needs network + git + disk-write that the ADR-0015 §6 sandbox denies) and is explicitly rejected.

> **The line:** the *framework* (loader, settings, marketplace, dock, explorer) is core; every *IDE capability* (languages, themes, runners, debug, panels) is a plugin. ADR-0013's "no private shortcuts" still binds — it governs how capabilities are built, not whether the loader is itself a plugin. VSCode draws the identical line (its extension host and marketplace client are core).

### 2. Manifest: `contributes`-based identity, `categories` as a derived browsing facet

A plugin's identity is **what it plugs into**, declared in `contributes` — *not* a single `kind` enum. `categories` is a separate, multi-valued **storefront browsing facet** that may also be inferred from which `contributes` keys are present.

```jsonc
{
  "id": "sindri.lang.rust",            // publisher.name namespacing (ADR-0013)
  "name": "Rust",
  "version": "0.3.1",                  // semver; resolved against git tags (§4)
  "engines": { "sindri": "^0.x" },     // compat gate; refuse-install on mismatch
  "publisher": "sindri",
  "description": "First-class Rust support.",
  "categories": ["Language Support"],  // DERIVED/declared browsing facet (multi-valued)
  "permissions": ["env.fs", "env.exec"], // gates host injection (ADR-0015 §6)
  "contributes": {                      // the REAL identity — wired by the loader
    "themes":       [ /* ThemeDef (ADR-0019) — DATA, no host needed */ ],
    "iconThemes":   [ /* IconThemeDef (ADR-0019) — DATA, no host needed */ ],
    "lsp":          [ /* { id, launch: ProcessSpec, capabilities } */ ],
    "dap":          [ /* { id, launch: ProcessSpec } */ ],
    "grammars":     [ /* tree-sitter grammar refs */ ],
    "taskAdapters": [ /* SAP adapter ids (ADR-0014) */ ],
    "languages":    [ /* raw provider contributions */ ],
    "panels":       [ /* sindri.window view contributions */ ],
    "configuration":[ /* settings schema — consumed by ADR-0021 */ ]
  },
  "readme": "README.md",               // the storefront "front page"
  "main": "dist/extension.js"          // present only for code-bearing plugins (needs host)
}
```

**Canonical category set** (for storefront aisles; declarable, also inferable from `contributes`):
`Language Support` · `Color Theme` · `File Icon Theme` · `UI Icon Theme` · `Test & Task Adapter` · `UI Extension`.

A plugin may sit in several aisles — a language pack legitimately appears under *Language Support* and, if it ships a `.rs` icon, *File Icon Theme*.

### 3. Repository layout: folder-per-extension + a generated index (no tree-walk)

A registry is a git repo where **each extension is a top-level folder** containing its manifest at the folder root:

```
my-registry/
  index.json                 ← generated; the marketplace reads THIS first
  rust/        manifest.json  README.md  dist/…
  dracula/     manifest.json  README.md
  …
```

- **`index.json` is authoritative for listing.** A CI step concatenates every folder's manifest (plus its resolved tags) into one root file. The marketplace fetches **one** file to populate the whole storefront — no per-folder round-trips, no API rate-limit storms.
- **Tree-scan is the fallback only.** For a repo without an `index.json`, the client may scan top-level folders for `manifest.json`. This is slow and best-effort; our central repo always ships an index and we document the CI step for custom repos.
- The **README in each folder is the front page** rendered in the storefront detail view (ADR-0013's "author-controlled landing").

### 4. Versioning & updates: git tags + semver

Updates resolve **git tags** against the manifest `version` (semver). The default branch's in-progress commits are *not* installed.

- Install/update picks the highest tag satisfying the user's constraint and `engines.sindri`.
- "Update available" = a higher satisfying tag than the installed version.
- Authors publish by tagging; the `index.json` records available tags per extension.

Rejected: "latest on default branch" (no version concept, ships unreleased/broken commits).

### 5. Registry transport: a `CoreClient`-style seam (ADR-0017)

Fetching is an interface selected once at load, mirroring `CoreClient` and the planned bus:

| Impl | Target | Mechanism |
|---|---|---|
| `TauriRegistryClient` | desktop | native `git` (clone/pull tag) via the Rust core; install to disk |
| `BrowserRegistryClient` | browser/PWA | raw-file fetch of `index.json` + assets, or host REST API (GitHub/GitLab); cache in OPFS/IndexedDB |

The browser target **cannot clone** — designing the seam now prevents the marketplace from silently being desktop-only. Installed extensions cache under `.sindri/extensions/<id>/<version>/` (desktop) or the browser-storage equivalent.

### 6. Trust & install-time provenance

Runtime capability is already gated by manifest permissions (ADR-0015 §6). **Install-time provenance is a separate concern** this ADR adds:

- **First-party repo** (the central Sindri registry): trusted; frictionless install.
- **Custom/third-party repos**: adding a repo and installing a **code-bearing** plugin (`main` present) shows a **trust prompt** naming the requested permissions.
- **Data-only plugins** (themes/icon themes — no `main`, no `env.*`): low-risk, installable without a trust gate even from custom repos.

### 7. Sequencing: data-plugins ship before the host

Per ADR-0019 a theme/icon theme is **data forwarded to the webview** — it needs *no* QuickJS host (ADR-0015, unbuilt). Therefore the marketplace is built **functional end-to-end for the data-only categories first** (Color Theme, File Icon Theme, and the reserved UI Icon Theme), proving the whole pipeline — repo config → `index.json` → storefront → install → register → live-apply → update — with zero host dependency.

Code-bearing categories (Language Support, Test/Task Adapter, UI Extension) install into the same cache but **activate only once the host lands**; until then the marketplace marks them "requires extension host" rather than blocking install.

## Consequences

- **Open, self-hostable distribution.** No app-store gatekeeper; anyone runs a registry by publishing a git repo + `index.json`.
- **The manifest is the single contract** read by loader, host, and marketplace — `contributes` wires capabilities, `categories` organizes the storefront, `permissions` gates the sandbox, `engines` gates compat.
- **A real vertical slice exists today** (themes/icons) decoupled from the unbuilt host, de-risking the marketplace before the hardest runtime work.
- **Browser parity is designed in**, not bolted on, via the registry transport seam.
- **Costs accepted:** authors must tag releases and (ideally) generate an `index.json`; a CI helper in the extension SDK should automate both. Tree-scan fallback exists but is explicitly second-class.

### Deferred

- Extension SDK tooling: `index.json` generator + `@sindri/api` types + esbuild bundling (overlaps ADR-0015 deferred items).
- Signing / checksums for tamper-evidence beyond git-tag trust.
- Dependency resolution *between* extensions (a pack depending on another).
- `net` permission scoping (still deferred from ADR-0015 §6).

## See also

- [ADR-0006](0006-extension-api-from-day-one.md) / [ADR-0013](0013-product-identity-and-polyglot-thesis.md) — everything-is-a-plugin; day-one extension set
- [ADR-0015](0015-js-extension-host-runtime.md) — host runtime, `sindri.*` surface, permission gating
- [ADR-0017](0017-browser-pwa-target.md) — the core-transport seam the registry client mirrors
- [ADR-0019](0019-theme-and-icon-system.md) — theme/icon-as-data; the no-host slice this ADR sequences first
- [ADR-0021](0021-settings-surface.md) — settings UI that consumes `contributes.configuration`
