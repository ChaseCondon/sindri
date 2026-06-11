// Extension manifest schema — ADR-0020 §2
// A plugin's identity is what it plugs into (contributes), not a single "kind".
// categories[] is the storefront browsing facet; contributes{} is what the loader wires.

export type ExtensionCategory =
  | "Language"            // programming-language support (grammar, LSP, DAP, or any combination)
  | "Localisation"        // human-language UI translations (requires extension host)
  | "Color Theme"
  | "File Icon Theme"
  | "UI Icon Theme"
  | "Test & Task Adapter"
  | "UI Extension"
  | "Extension Pack"      // curated bundle of multiple extensions installed together
  | "Other";              // catch-all for categories outside the predefined list

export interface ThemeContribution {
  id: string;
  name: string;
  kind: "light" | "dark";
  path: string; // relative to extension folder — a ThemeDef JSON file
  // Optional per-language code snippets shown in the marketplace preview block.
  // Keys are language display names (e.g. "TypeScript", "Rust", "Python").
  previews?: Record<string, string>;
}

export interface IconThemeContribution {
  id: string;
  name: string;
  kind: "color" | "mono";
  path: string; // relative to extension folder — an IconThemeDef JSON file
}

export interface UiIconPackContribution {
  id: string;
  name: string;
  path: string; // relative to extension folder — a UiIconPackDef JSON file
}

export interface LspContribution {
  id: string;
  languageId: string;
  launch: { command: string; args?: string[] };
}

export interface DapContribution {
  id: string;
  languageId: string;
  launch: { command: string; args?: string[] };
}

export interface GrammarContribution {
  languageId: string;
  path: string;
}

export interface TaskAdapterContribution {
  id: string;
  languageId: string;
}

export interface ConfigurationField {
  type: "boolean" | "string" | "number" | "enum";
  default: unknown;                             // required — every field has a schema default
  description?: string;
  title?: string;                               // explicit row label; overrides auto-generated key label
  groupTitle?: string;                          // renders a <h3> subsection header before this field
  // enum
  enum?: string[];
  enumLabels?: string[];                        // human labels, positionally aligned to enum[]
  presentation?: "dropdown" | "radio" | "range"; // render hint; "range" for number sliders
  // number
  minimum?: number; maximum?: number; step?: number;
  // layout
  order?: number;                               // sort position within section; ties break on key
  when?: string;                                // show only if this boolean setting key is truthy
}

export interface ConfigurationSchema {
  [key: string]: ConfigurationField;
}

// Where in the Settings nav this extension's config section lives.
// Omit to default to "Extensions > [extension name]".
export interface ConfigurationNavSection {
  group: string;   // e.g. "Appearance", "Extensions" — matches a nav group label
  label: string;   // e.g. "Editor", "My Extension" — the section item label
  order?: number;  // sort position within the group
}

export interface ConfigurationContribution {
  navSection?: ConfigurationNavSection;
  schema: ConfigurationSchema;
}

// Panel contributions — ADR-0022 (proposed; wired when QuickJS host ships)
export interface PanelContribution {
  id: string;             // e.g. "sindri.search" — globally unique
  title: string;          // shown in activity bar tooltip and panel header
  icon: string;           // path to SVG icon, relative to extension folder
  defaultSection: "left-top" | "left-bottom" | "right-top" | "right-bottom" | "bottom";
}

// ADR-0026 §4 Tier 1 — declarative tree-view panel metadata.
export interface TreeViewContribution {
  id: string;
  title: string;
  icon?: string;
  defaultDock?: "left-top" | "left-bottom" | "right-top" | "right-bottom" | "bottom";
}

// ADR-0026 §4 Tier 2 — webview escape hatch panel metadata.
// The HTML is produced at runtime by WebviewPanelProvider.getHtml(); only the
// dock placement / labelling metadata lives in the manifest.
export interface WebviewPanelContribution {
  id: string;
  title: string;
  icon?: string;
  defaultDock?: "left-top" | "left-bottom" | "right-top" | "right-bottom" | "bottom";
}

export interface ExtensionContributes {
  themes?: ThemeContribution[];
  iconThemes?: IconThemeContribution[];
  uiIconPacks?: UiIconPackContribution[]; // activity bar / toolbar icon packs (distinct from file icon themes)
  lsp?: LspContribution[];
  dap?: DapContribution[];
  grammars?: GrammarContribution[];
  taskAdapters?: TaskAdapterContribution[];
  panels?: PanelContribution[];            // ADR-0022 — sidebar panels (requires extension host)
  treeViews?: TreeViewContribution[];      // ADR-0026 §3 Tier 1
  webviewPanels?: WebviewPanelContribution[]; // ADR-0026 §4 Tier 2
  configuration?: ConfigurationContribution; // ADR-0023 — settings schema
}

export interface ExtensionManifest {
  id: string;             // publisher.name — e.g. "sindri.aurora-theme"
  name: string;
  version: string;        // semver; resolved against git tags (ADR-0020 §4)
  publisher: string;
  description: string;
  categories: ExtensionCategory[];
  tags?: string[];        // free-form search/filter tags (e.g. ["dark", "minimal"])
  languages?: string[];   // programming language IDs this extension relates to (e.g. ["rust", "python"])
  icon?: string;          // path to extension logo (PNG or SVG), relative to extension folder
  bugs?: { url?: string; email?: string }; // issue tracker / contact for the "Report issue" button
  permissions: string[];  // ADR-0015 §6 — gates host injection
  engines: { sindri: string }; // compat range — refuse-install on mismatch
  contributes: ExtensionContributes;
  extensionPack?: string[]; // for "Extension Pack" category — IDs of extensions to install together
  packKind?: "theme" | "language" | "general"; // optional sub-label for extension packs
  extends?: string;       // ADR-0032: base icon theme to inherit from (publisher.name format)
  variables?: Record<string, string>; // ADR-0032: CSS custom property overrides for inherited icon theme
  license?: string;        // SPDX identifier for the extension's own license (e.g. 'AGPL-3.0-only')
  credits?: Array<{       // third-party asset attribution shown in the extension detail panel
    name: string;         // name of the credited work
    spdx?: string;        // SPDX license identifier (e.g. 'MIT', 'ISC', 'CC0-1.0')
    url?: string;         // URL to source project or license text
    notice?: string;      // copyright/attribution notice text
  }>;
  main?: string;          // entry bundle — present only for code-bearing plugins; absent = data-only
}

// Lean wire format for index.json (ADR-0020 §3).
// Each list is a flat array of folder paths — no IDs or memberPaths.
// The registry client fetches manifest.json from each path; packs/collections
// are walked recursively by deriving member paths from manifest extensionPack fields.
export interface RegistryLeanIndex {
  name?: string;
  description?: string;
  homepage?: string;
  // Current format — flat folder-path strings per category:
  extensions?:  string[];   // paths to standalone leaf extensions
  packs?:       string[];   // paths to extension pack roots
  collections?: string[];   // paths to collection pack roots
  // Legacy flat format (backward compat — still accepted by enrichLeanIndex):
  extensionFolders?: string[];
}

// Enriched form used by the UI — assembled by the registry client after
// fetching individual manifest.json files.
export interface RegistryIndexEntry {
  manifest: ExtensionManifest;
  tags: string[];
  readmeContent?: string;  // loaded on demand, not from index.json
  folderPath: string;
  isMember?: boolean;      // true for extensions discovered as pack/collection members — not shown top-level
}

export type RegistryIndex = RegistryIndexEntry[];
