# ADR-0038: Manifest `type` taxonomy & id-based registry resolution

- **Status:** Accepted — 2026-06-15
- **Supersedes:** [ADR-0020](0020-extension-distribution-and-marketplace.md) §3 (flat folder-path index) · [ADR-0032](0032-extension-templates-inheritance.md) §6 (typed `{id,path}` buckets; "base is a standalone installable entry")
- **Reaffirms / completes:** [ADR-0032](0032-extension-templates-inheritance.md) §5 (resolve `extends` + `extensionPack` **by id**, object-pin & `remote` forms)
- **Phase:** 1.5 — Extension author DX & registry correctness

---

## Context

Three forces converged:

1. **The implementation drifted from ADR-0032.** ADR-0032 §5 specified that `extends` and `extensionPack` resolve **by id** against the index, and §6 specified `index.json` entries carrying `{ id, path }` so the resolver never tree-walks. The shipped code did neither: `index.json` is a flat array of **folder-path strings** (no ids), and `registry-client.ts::discoverMembers` **guesses** member folder paths (publisher-prefix first, then plain name). Every wrong guess fires a `manifest.json` 404. The long "404 saga" (aurora pack, community collection members, `icons.json`) is entirely this drift — path-guessing where the ADR called for id lookup.

2. **Kind is inferred from side-channels.** The engine decides whether a manifest is a leaf, a pack, a collection, or a template from three uncorrelated signals: `extensionPack.length > 0`, `categories` containing `"Icon Theme Base"`, and which `index.json` bucket (`extensions`/`packs`/`collections`) the entry sits in. None is authoritative; they can disagree.

3. **Templates need to be releasable and extendable by third parties.** A base like `sindri.community-icons-base` exists only to be `extends`-ed (ADR-0032). It is **not installable** on its own, yet ADR-0032 §6 listed it as a standalone installable `extensions` entry. We want bases that anyone — in any registered registry — can extend, without surfacing them as fake installable extensions.

### Constraints

- **Index is the resolution contract** (ADR-0032 §6 principle) — no runtime tree-walk, no path-guessing.
- **Cross-registry references must keep working** (ADR-0032 §5) — object-pin `{ id, registry }` and the serialized `{ id, remote: true }` form.
- **`index.json` stays generated** by the `sindri` CLI (ADR-0033), never hand-edited.
- **Backward-compat** for already-deployed `index.json` files read over `raw.githubusercontent.com` during the transition.

---

## Decision

### §1. `type` — authoritative manifest kind

A new optional manifest field replaces all inferred-kind side-channels:

```jsonc
"type": "extension" | "pack" | "collection" | "template"
```

| `type` | Meaning | Installable | Listed in browse UI |
|---|---|---|---|
| `extension` | Leaf — contributes themes/icons/code. **Default** when the field is absent (back-compat). | yes | yes |
| `pack` | Installs all `extensionPack` members together. | yes (installs members) | yes |
| `collection` | Curated grouping; members are individually selectable, not bulk-installed. | members individually | yes (as a group) |
| `template` | Non-installable base; exists only as an `extends` target (ADR-0032). | **no** | **no** (resolvable by id, hidden from browse/install) |

`type` is the single source of truth. The engine no longer reads `extensionPack.length`, `categories: ["Icon Theme Base"]`, or index-bucket membership to decide kind.

### §2. `index.json` — flat, id-carrying `entries`

The typed buckets of ADR-0032 §6 and the flat folder-strings of ADR-0020 §3 are both replaced by **one flat list of self-describing rows**:

```jsonc
{
  "name": "Sindri Sample Extensions",
  "description": "…",
  "homepage": "…",
  "entries": [
    { "id": "sindri.color-swatches",            "path": "sindri-color-swatches",                               "type": "extension"  },
    { "id": "sindri.neon-icons",                "path": "neon-icons",                                          "type": "extension"  },
    { "id": "sindri.aurora-theme-pack",         "path": "aurora-theme-pack",                                   "type": "pack"       },
    { "id": "sindri.community-theme-collection","path": "community-theme-collection",                          "type": "collection" },
    { "id": "sindri.catppuccin-mocha",          "path": "community-theme-collection/sindri-catppuccin-mocha",  "type": "pack"       },
    { "id": "sindri.community-icons-base",       "path": "community-theme-collection/sindri-community-icons-base","type": "template" }
  ]
}
```

- Each row carries **`id`, `path`, `type`** — everything the resolver and the marketplace need **without fetching a single `manifest.json`**.
- Buckets are gone; `type` carries what the bucket used to. Adding a new kind needs no structural change.
- **All resolvable entries are listed**, including nested pack members and hosted templates — the index is the complete, flat resolution map. On-disk folder nesting remains an authoring convenience the generator flattens (ADR-0032 §6 principle, preserved).

### §3. Resolution is by id — path-guessing is removed

`extends` and every `extensionPack` member resolve by **id lookup against `entries`** (the union across all registered registries + bundled core), reaffirming ADR-0032 §5:

- **String id** → first match across registries in priority order.
- **Object pin** `{ id, registry }` → resolve only in the named registry.
- **Unresolved remote** → serialized `{ id, remote: true }`; the marketplace warns rather than failing.

`registry-client.ts::discoverMembers` and `memberFolders` are **deleted** — they exist only to guess paths, which the id-carrying index makes obsolete. No fetch can 404 from a wrong guess because nothing is guessed.

> This is the actual fix for the 404 saga. The `memberFolders` map added during the saga is removed; the index carries the path authoritatively.

### §4. `provides` — pack/collection-hosted templates

A pack or collection may **host** templates that ship inside its folder tree, declared via a new field distinct from `extensionPack`:

```jsonc
{
  "id": "sindri.community-theme-collection",
  "type": "collection",
  "extensionPack": [ /* installable members */ ],
  "provides": [ "sindri.community-icons-base" ]   // hosted templates — NOT installed with the collection
}
```

- `extensionPack` = "install these." `provides` = "host/expose these bases." A pack never *installs* a template; installing an extension that `extends` one pulls the base's data transitively (ADR-0032 §3 merge).
- The CLI **generator reads `provides`** and emits each hosted template into `entries` as a `type: template` row with its full path. After generation, resolution is uniform id lookup (§3) — a hosted template is indistinguishable from a standalone one at resolve time. This is "support both": a template may be a **top-level** `type: template` entry (independently released) **or** hosted by a pack/collection via `provides` (released with its host).

### §5. Template semantics (revises ADR-0032 §6)

A `type: template` entry is **resolvable but not installable**:

- Hidden from the marketplace browse list and the "Installed/Dev" management tabs; no install button.
- Present in `entries` (and thus `_allEntries`) so `extends` resolves by id (§3).
- Consumed only transitively: `doInstall`/`reinstallEntry` follow a child's `extends` to the base entry and fetch the base's `icons.json` (the redirect already implemented during the 404 saga).

This supersedes ADR-0032 §6's "the base extension **is** a standalone `extensions` entry — installable on its own." It is now a non-installable `template`.

### §6. CLI & CI/CD alignment (ADR-0033)

- **`sindri ext build-index`** emits the §2 flat `entries` shape: walk top-level dirs + nested pack/collection members, read each manifest's `type` (default `extension`), expand `provides` into `type: template` rows, write `{ id, path, type }`.
- **`sindri ext validate`** enforces: `type` ∈ the enum (or absent ⇒ `extension`); `extends` targets resolve to a `type: template` (or any entry under `relaxedPackValidation`, ADR-0032 §7); `provides` entries exist on disk and are `type: template`; `extensionPack` members are not templates.
- **`sindri ext changed`/`plan`/`bump`/`release`** treat `type: template` as a normal versioned, releasable unit (own tag/artifact) — a template is published like any other entry; only its *installability* differs. Collection-hosted templates version with their host.
- **CI/CD** (`pr-check`, `nightly`, `release` workflows) regenerate the index via the CLI and validate it; no workflow hand-asserts bucket structure.

### §7. Backward-compatibility & migration

`enrichLeanIndex` accepts, in priority order: (1) `entries` (§2, new); (2) legacy `extensions`/`packs`/`collections` buckets (ADR-0032 §6); (3) legacy `extensionFolders` flat strings (ADR-0020 §3). Legacy formats lack ids, so they fall back to the old fetch-then-derive path **without** path-guessing for members (members in legacy indexes were already top-level-listed). New registries emit only `entries`. The in-repo `index.json` is regenerated to `entries` immediately.

---

## Consequences

### What we gain

- **The 404 saga is structurally closed** — no path-guessing exists to 404. Resolution is a map lookup.
- **One authoritative kind** (`type`) — no more disagreement between `extensionPack.length`, `categories`, and index buckets.
- **Releasable, extendable templates** — `type: template` is published like anything else, resolvable cross-registry by id (ADR-0032 §5), yet never shown as installable. Third parties extend a base by id whether it's standalone or collection-hosted.
- **Cheaper listing & resolution** — `id`+`type`+`path` in the index means the marketplace and resolver work without fetching member manifests up front.

### Costs / things we accept

- **Index schema change** — `RegistryLeanIndex`, `enrichLeanIndex`, `build-index`, and the CI validators all change together. One-time migration; legacy formats stay readable (§7).
- **Two reversals of accepted ADRs** (0020 §3, 0032 §6) — captured here rather than by rewriting those ADRs; their bodies get a one-line supersede pointer.
- **`type` duplicated** in manifest and index — acceptable: the index is generated from manifests, the generator copies it; the index copy is the resolver's fast path.

### Deferred

- **Version-pinned `extends`** — `extends` still resolves to "latest in registry," not a pinned template version. A `{ id, version }` pin is deferred until a consumer needs reproducible base versions.
- **Template dependency graph in CI** — bumping a template does not yet auto-rebuild dependents. Deferred until templates have external consumers that need it.
- **`type` for non-icon inheritance** — `template` remains icon-theme-scoped per ADR-0032 §8 until a second use case appears.

---

## See also

- [ADR-0020](0020-extension-distribution-and-marketplace.md) — manifest/`contributes`/`categories`, git-repo registries, generated `index.json` (§3 superseded here)
- [ADR-0032](0032-extension-templates-inheritance.md) — `extends`/`variables`, template merge, by-id resolution (§5 reaffirmed; §6 superseded here)
- [ADR-0033](0033-sindri-cli.md) — the `sindri ext` release engine that generates & validates the index
