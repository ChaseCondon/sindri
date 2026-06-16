// Marketplace storefront — ADR-0020 §3 / §7
// Search bar | Category sidebar | Extension list | Detail pane
import { createSignal, createResource, For, Show, createMemo, ErrorBoundary, createEffect, onCleanup } from "solid-js";
import type { ExtensionCategory, ExtensionManifest, RegistryIndexEntry } from "../../extensions/manifest";
import { getRegistryClient, rawFileUrl, resolveIconThemeDef, resolveUiIconPackDef } from "../../extensions/registry-client";
import { activateExtensionFromSinxt, activateExtensionWithManifest } from "../../extensions/activation";
import { checkUpdatesOnly } from "../../extensions/update-checker";
import { registerTheme, unregisterTheme, registerIconTheme, unregisterIconTheme, registerUiIconPack, unregisterUiIconPack, getThemeDef, setUiTheme, setIconTheme, setUiPack } from "../../theme/registry";
import { unregisterToolWindow } from "../layout";
import { removeExtensionLogs, registerExtension as registerLogChannel } from "../panels/ext-logs-store";
import type { ThemeDef } from "../../theme/tokens";
import {
  registryRepos, installedIds, installedExtensions, installExtension, uninstallExtension,
  setExtensionEnabled,
  liveThemePreview, setPreviewThemeDef,
  type InstalledRecord,
} from "./store";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../lib/tauri";
// No explicit showExtensionErrors import — replaced by per-repo developerMode
import bundledExtensions from "../../../core-extensions/bundled-extensions.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Extends RegistryIndexEntry with the source repo URL (null = bundled core)
interface MarketplaceEntry {
  item: RegistryIndexEntry;
  repoUrl: string | null; // null for bundled core extensions
}

// ---------------------------------------------------------------------------
// Category config
// ---------------------------------------------------------------------------

const CATEGORY_GROUPS: { label: string; cats: (ExtensionCategory | "All")[] }[] = [
  { label: "",              cats: ["All"] },
  { label: "Packs",         cats: ["Extension Pack"] },
  { label: "Themes",        cats: ["Color Theme", "File Icon Theme", "UI Icon Theme"] },
  { label: "Languages",     cats: ["Language", "Test & Task Adapter"] },
  { label: "Accessibility", cats: ["Localisation"] },
  { label: "Interface",     cats: ["UI Extension"] },
  { label: "",              cats: ["Other"] },
];

const CATEGORY_ICONS: Partial<Record<ExtensionCategory | "All", string>> = {
  "All":                 "◈",
  "Extension Pack":      "⊕",
  "Color Theme":         "◐",
  "File Icon Theme":     "⊞",
  "UI Icon Theme":       "⊟",
  "Language":            "λ",
  "Localisation":        "⬡",
  "Test & Task Adapter": "⚙",
  "UI Extension":        "⊡",
  "Other":               "…",
};

// Categories with explicit sidebar entries — used to determine "Other" membership
const KNOWN_CATS = new Set<string>([
  "Extension Pack", "Color Theme", "File Icon Theme", "UI Icon Theme",
  "Language", "Localisation", "Test & Task Adapter", "UI Extension", "Other",
]);

function isExtensionPack(manifest: ExtensionManifest): boolean {
  return (manifest.extensionPack?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Fuzzy / tag search
// Prefix syntax:  @publisher:sindri  @category:theme  @lang:rust
// Remaining terms are fuzzy-matched against name/description
// ---------------------------------------------------------------------------

function fuzzyMatch(query: string, entry: RegistryIndexEntry): boolean {
  if (!query.trim()) return true;

  const tokens = query.trim().toLowerCase().split(/\s+/);
  const manifest = entry.manifest;

  const freeTerms: string[] = [];

  for (const token of tokens) {
    if (token.startsWith("@publisher:")) {
      const val = token.slice("@publisher:".length);
      if (!manifest.publisher.toLowerCase().includes(val)) return false;
    } else if (token.startsWith("@category:") || token.startsWith("@cat:")) {
      const val = token.slice(token.indexOf(":") + 1);
      if (!manifest.categories.some((c) => c.toLowerCase().includes(val))) return false;
    } else if (token.startsWith("@lang:")) {
      const val = token.slice("@lang:".length);
      if (!manifest.languages?.some((l) => l.toLowerCase().includes(val))) return false;
    } else if (token.startsWith("@tag:")) {
      const val = token.slice("@tag:".length);
      if (!manifest.tags?.some((t) => t.toLowerCase().includes(val))) return false;
    } else {
      freeTerms.push(token);
    }
  }

  if (freeTerms.length === 0) return true;
  const haystack = [
    manifest.name,
    manifest.description,
    manifest.publisher,
    ...(manifest.categories ?? []),
    ...(manifest.tags ?? []),
    ...(manifest.languages ?? []),
  ].join(" ").toLowerCase();
  return freeTerms.every((t) => haystack.includes(t));
}

// ---------------------------------------------------------------------------
// Pre-release + version helpers
// ---------------------------------------------------------------------------

function isPrerelease(tag: string): boolean {
  const v = tag.startsWith("v") ? tag.slice(1) : tag;
  return v.includes("-");
}

function latestStableTag(tags: string[], showPre: boolean): string | null {
  const filtered = showPre ? tags : tags.filter((t) => !isPrerelease(t));
  return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}

// Returns true if the registry has a newer version than what is installed.
function hasUpdate(me: MarketplaceEntry): boolean {
  if (!me.repoUrl) return false;
  const record = installedExtensions().find((r) => r.id === me.item.manifest.id);
  if (!record) return false;
  const repo = registryRepos().find((r) => r.url === me.repoUrl);
  const latest = latestStableTag(me.item.tags ?? [], repo?.showPrerelease ?? false);
  if (!latest) return false;
  const latestVer = latest.startsWith("v") ? latest.slice(1) : latest;
  return latestVer !== record.manifest.version;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchAllEntries(): Promise<MarketplaceEntry[]> {
  const client = getRegistryClient();
  const repos = registryRepos();

  const remoteResults = await Promise.all(
    repos.map(async (repo) => {
      const index = await client.fetchIndex(repo.url);
      return (index ?? []).map((item) => ({ item, repoUrl: repo.url } as MarketplaceEntry));
    })
  );

  const coreEntries: MarketplaceEntry[] = (bundledExtensions as RegistryIndexEntry[]).map(
    (item) => ({ item, repoUrl: null })
  );

  const seen = new Set<string>();
  const merged: MarketplaceEntry[] = [];

  for (const e of [...coreEntries, ...remoteResults.flat()]) {
    const id = e.item.manifest.id;
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(e);
    }
  }
  _allEntries = merged;
  // Templates are hidden (not directly installable); all other entries including pack members
  // appear in the browse list so they can be individually discovered and installed.
  return merged.filter(e => e.item.manifest.type !== "template");
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

let _allEntries: MarketplaceEntry[] = [];

async function doInstall(entry: MarketplaceEntry): Promise<boolean> {
  const { item, repoUrl } = entry;
  const { contributes, id, extensionPack } = item.manifest;

  // Extension pack — install each member; only mark pack installed if all succeed.
  if (extensionPack?.length) {
    let allOk = true;
    for (const memberId of extensionPack) {
      const memberEntry = _allEntries.find((e) => e.item.manifest.id === memberId);
      if (memberEntry) {
        const ok = await doInstall(memberEntry);
        if (!ok) allOk = false;
      }
    }
    if (allOk && repoUrl) installExtension(id, repoUrl, item.folderPath, item.manifest);
    return allOk;
  }

  for (const theme of contributes.themes ?? []) {
    if (!repoUrl) continue; // bundled themes are already registered at startup
    const url = rawFileUrl(repoUrl, item.folderPath, theme.path);
    if (!url) continue;
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const def = await res.json() as ThemeDef;
      registerTheme(def);
    } catch (err) {
      console.error("[Marketplace] failed to install theme", theme.id, err);
      return false;
    }
  }

  for (const iconTheme of contributes.iconThemes ?? []) {
    if (!repoUrl) continue;

    // ADR-0032: if this extension inherits from a base icon theme, fetch the
    // base's icons.json and overlay the child's id/name/cssVars.
    let iconJsonUrl = rawFileUrl(repoUrl, item.folderPath, iconTheme.path);
    let cssVars: Record<string, string> | undefined;
    if (item.manifest.extends) {
      const baseEntry = _allEntries.find((e) => e.item.manifest.id === item.manifest.extends);
      if (baseEntry?.repoUrl) {
        const basePath = baseEntry.item.manifest.contributes?.iconThemes?.[0]?.path ?? "icons.json";
        iconJsonUrl = rawFileUrl(baseEntry.repoUrl, baseEntry.item.folderPath, basePath) ?? iconJsonUrl;
      }
      if (item.manifest.variables) {
        cssVars = Object.fromEntries(
          Object.entries(item.manifest.variables).map(([k, v]) => [`--${k}`, v]),
        );
      }
    }

    if (!iconJsonUrl) continue;
    try {
      const res = await fetch(iconJsonUrl, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json() as Record<string, unknown>;
      const def = await resolveIconThemeDef(raw, iconJsonUrl);
      registerIconTheme({ ...def, id: iconTheme.id, name: iconTheme.name, ...(cssVars ? { cssVars } : {}) });
    } catch (err) {
      console.error("[Marketplace] failed to install icon theme", iconTheme.id, err);
      return false;
    }
  }

  for (const uiPack of contributes.uiIconPacks ?? []) {
    if (!repoUrl) continue;
    const url = rawFileUrl(repoUrl, item.folderPath, uiPack.path);
    if (!url) continue;
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json() as Record<string, unknown>;
      const def = await resolveUiIconPackDef(raw, url);
      registerUiIconPack(def);
    } catch (err) {
      console.error("[Marketplace] failed to install UI icon pack", uiPack.id, err);
      return false;
    }
  }

  // Code extension — download and activate the .sinxt bundle.
  if (repoUrl && item.manifest.main) {
    const client = getRegistryClient();
    const sinxtPath = await client.downloadExtension(item, item.manifest.version, repoUrl);
    if (sinxtPath) {
      installExtension(id, repoUrl, item.folderPath, item.manifest, sinxtPath);
      await activateExtensionFromSinxt(sinxtPath, item.manifest);
      return true;
    }
    console.error(`[Marketplace] failed to download .sinxt for ${id}`);
    return false;
  }

  if (repoUrl) installExtension(id, repoUrl, item.folderPath, item.manifest);
  return true;
}

function doUninstall(entry: MarketplaceEntry): void {
  const { item } = entry;
  const { contributes, id, extensionPack } = item.manifest;

  if (extensionPack?.length) {
    for (const memberId of extensionPack) {
      const memberEntry = _allEntries.find((e) => e.item.manifest.id === memberId);
      if (memberEntry) doUninstall(memberEntry);
    }
    removeExtensionLogs(id);
    uninstallExtension(id);
    if (isTauri()) invoke("ext_deactivate", { extId: id }).catch(() => {});
    return;
  }

  for (const theme of contributes?.themes ?? []) unregisterTheme(theme.id);
  for (const iconTheme of contributes?.iconThemes ?? []) unregisterIconTheme(iconTheme.id);
  for (const uiPack of contributes?.uiIconPacks ?? []) unregisterUiIconPack(uiPack.id);
  for (const wp of contributes?.webviewPanels ?? []) unregisterToolWindow(wp.id);
  for (const tv of contributes?.treeViews ?? []) unregisterToolWindow(tv.id);
  removeExtensionLogs(id);
  uninstallExtension(id);
  if (isTauri()) invoke("ext_deactivate", { extId: id }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Re-registration on reload (called from App.tsx at startup)
// ---------------------------------------------------------------------------

export async function rehydrateInstalledExtensions(): Promise<void> {
  // Pass 1 — synchronous: register log channels for all enabled extensions so
  // the Extension Logs panel shows them immediately on startup.
  for (const record of installedExtensions()) {
    if (record.enabled === false) continue;
    if (record.manifest.id) {
      registerLogChannel(
        record.manifest.id,
        record.manifest.name ?? record.manifest.id,
        record.manifest.categories ?? ["Other"],
      );
    }
  }

  // Pass 2 — activate sinxt and dev extensions immediately, without waiting
  // for a network fetch. Their sinxtPath/folderPath is already on disk so
  // tool windows (sidebar icons) appear as soon as the Tauri command returns.
  const needsNetwork: InstalledRecord[] = [];
  for (const record of installedExtensions()) {
    if (record.enabled === false) continue;

    if (record.repoUrl === "dev" && record.folderPath) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const devDir = await invoke<string>("ext_restart_watch", {
          extId: record.id,
          folderPath: record.folderPath,
        });
        await activateExtensionWithManifest(`${devDir}/extension.js`);
      } catch (e) {
        console.warn(`[Marketplace] dev extension ${record.id} needs re-load from source:`, e);
      }
      continue;
    }

    if (record.sinxtPath) {
      await activateExtensionFromSinxt(record.sinxtPath, record.manifest).catch((e) => {
        console.error(`[Marketplace] failed to reactivate sinxt for ${record.id}:`, e);
      });
      continue;
    }

    // Bundled/theme extensions without a sinxtPath need the network index to reinstall.
    needsNetwork.push(record);
  }

  // Pass 3 — fetch the registry index (needed for UI and for reinstalling
  // bundled/theme entries that have no sinxtPath).
  const client = getRegistryClient();
  const repos = registryRepos();
  const repoIndexes = new Map<string, MarketplaceEntry[]>();
  await Promise.all(
    repos.map(async (repo) => {
      const index = await client.fetchIndex(repo.url);
      if (index) {
        repoIndexes.set(repo.url, index.map((item) => ({ item, repoUrl: repo.url })));
      }
    })
  );
  const coreEntries: MarketplaceEntry[] = (bundledExtensions as RegistryIndexEntry[]).map(
    (item) => ({ item, repoUrl: null })
  );
  _allEntries = [...coreEntries, ...[...repoIndexes.values()].flat()];

  for (const record of needsNetwork) {
    const entry = _allEntries.find((e) => e.item.manifest.id === record.id);
    if (!entry || entry.repoUrl === null) continue;
    await reinstallEntry(entry);
  }
}

async function reinstallEntry(entry: MarketplaceEntry): Promise<void> {
  const { item, repoUrl } = entry;
  const { contributes, extensionPack } = item.manifest;
  if (!repoUrl) return;

  if (extensionPack?.length) {
    for (const memberId of extensionPack) {
      const memberEntry = _allEntries.find((e) => e.item.manifest.id === memberId);
      if (memberEntry) await reinstallEntry(memberEntry);
    }
    return;
  }

  for (const theme of contributes.themes ?? []) {
    const url = rawFileUrl(repoUrl, item.folderPath, theme.path);
    if (!url) continue;
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (res.ok) registerTheme(await res.json() as ThemeDef);
    } catch { /* skip */ }
  }

  for (const iconTheme of contributes.iconThemes ?? []) {
    // ADR-0032: redirect to base's icons.json when this extension uses `extends`
    let iconJsonUrl = rawFileUrl(repoUrl, item.folderPath, iconTheme.path);
    let cssVars: Record<string, string> | undefined;
    if (item.manifest.extends) {
      const baseEntry = _allEntries.find((e) => e.item.manifest.id === item.manifest.extends);
      if (baseEntry?.repoUrl) {
        const basePath = baseEntry.item.manifest.contributes?.iconThemes?.[0]?.path ?? "icons.json";
        iconJsonUrl = rawFileUrl(baseEntry.repoUrl, baseEntry.item.folderPath, basePath) ?? iconJsonUrl;
      }
      if (item.manifest.variables) {
        cssVars = Object.fromEntries(
          Object.entries(item.manifest.variables).map(([k, v]) => [`--${k}`, v]),
        );
      }
    }
    if (!iconJsonUrl) continue;
    try {
      const res = await fetch(iconJsonUrl, { cache: "no-cache" });
      if (res.ok) {
        const raw = await res.json() as Record<string, unknown>;
        const def = await resolveIconThemeDef(raw, iconJsonUrl);
        registerIconTheme({ ...def, id: iconTheme.id, name: iconTheme.name, ...(cssVars ? { cssVars } : {}) });
      }
    } catch { /* skip */ }
  }

  for (const uiPack of contributes.uiIconPacks ?? []) {
    const url = rawFileUrl(repoUrl, item.folderPath, uiPack.path);
    if (!url) continue;
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (res.ok) {
        const raw = await res.json() as Record<string, unknown>;
        registerUiIconPack(await resolveUiIconPackDef(raw, url));
      }
    } catch { /* skip */ }
  }
}

// ---------------------------------------------------------------------------
// Default preview code — used when a colour theme has no explicit previews
// ---------------------------------------------------------------------------

const DEFAULT_PREVIEW: Record<string, string> = {
  TypeScript: `interface User {\n  id: string;\n  name: string;\n  role: "admin" | "viewer";\n}\n\nasync function getUser(id: string): Promise<User> {\n  const res = await fetch(\`/api/users/\${id}\`);\n  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);\n  return res.json() as Promise<User>;\n}`,
  JavaScript: `const CACHE_TTL = 5 * 60 * 1000;\n\nclass RegistryClient {\n  #cache = new Map();\n\n  async fetchIndex(repoUrl) {\n    const cached = this.#cache.get(repoUrl);\n    if (cached && Date.now() - cached.ts < CACHE_TTL) {\n      return cached.data;\n    }\n    const res = await fetch(\`\${toRawBase(repoUrl)}/index.json\`);\n    if (!res.ok) return null;\n    const data = await res.json();\n    this.#cache.set(repoUrl, { data, ts: Date.now() });\n    return data;\n  }\n}`,
  Rust: `use std::collections::HashMap;\n\n#[derive(Debug, Clone)]\npub struct Registry<T> {\n    entries: HashMap<String, T>,\n}\n\nimpl<T: Clone> Registry<T> {\n    pub fn new() -> Self {\n        Self { entries: HashMap::new() }\n    }\n\n    pub fn register(&mut self, id: impl Into<String>, value: T) {\n        self.entries.insert(id.into(), value);\n    }\n\n    pub fn get(&self, id: &str) -> Option<&T> {\n        self.entries.get(id)\n    }\n}`,
  Python: `from dataclasses import dataclass, field\n\n@dataclass\nclass Extension:\n    id: str\n    name: str\n    version: str\n    installed: bool = False\n    tags: list[str] = field(default_factory=list)\n\n    def matches(self, query: str) -> bool:\n        q = query.lower()\n        return q in self.name.lower() or any(q in t for t in self.tags)\n\n    def install(self) -> None:\n        if self.installed:\n            raise ValueError(f"{self.name!r} is already installed")\n        self.installed = True`,
  Go: `package registry\n\nimport "sync"\n\ntype Registry[T any] struct {\n    mu      sync.RWMutex\n    entries map[string]T\n}\n\nfunc New[T any]() *Registry[T] {\n    return &Registry[T]{entries: make(map[string]T)}\n}\n\nfunc (r *Registry[T]) Register(id string, value T) {\n    r.mu.Lock()\n    defer r.mu.Unlock()\n    r.entries[id] = value\n}\n\nfunc (r *Registry[T]) Get(id string) (T, bool) {\n    r.mu.RLock()\n    defer r.mu.RUnlock()\n    v, ok := r.entries[id]\n    return v, ok\n}`,
  Java: `import java.util.HashMap;\nimport java.util.Map;\nimport java.util.Optional;\n\npublic class Registry<T> {\n    private final Map<String, T> entries = new HashMap<>();\n\n    public void register(String id, T value) {\n        if (entries.containsKey(id)) {\n            throw new IllegalStateException("Already registered: " + id);\n        }\n        entries.put(id, value);\n    }\n\n    public Optional<T> get(String id) {\n        return Optional.ofNullable(entries.get(id));\n    }\n\n    public boolean isRegistered(String id) {\n        return entries.containsKey(id);\n    }\n}`,
  JSON: `{\n  "$schema": "../manifest.schema.json",\n  "id": "yourname.my-theme",\n  "name": "My Theme",\n  "version": "1.0.0",\n  "publisher": "yourname",\n  "categories": ["Color Theme"],\n  "permissions": [],\n  "engines": { "sindri": ">=0.1.0" },\n  "contributes": {\n    "themes": [\n      {\n        "id": "my-theme-dark",\n        "name": "My Theme Dark",\n        "kind": "dark",\n        "path": "dark.json"\n      }\n    ]\n  }\n}`,
  XML: `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>sindri-extension</artifactId>\n  <version>1.0.0</version>\n\n  <dependencies>\n    <dependency>\n      <groupId>org.junit.jupiter</groupId>\n      <artifactId>junit-jupiter</artifactId>\n      <version>5.10.0</version>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>\n</project>`,
  HTML: `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Sindri Extension</title>\n    <link rel="stylesheet" href="styles.css" />\n  </head>\n  <body>\n    <div class="container" id="app">\n      <h1 class="title">Hello, Sindri</h1>\n      <p class="subtitle">A human-first IDE</p>\n      <button class="btn-primary" onclick="greet()">Click me</button>\n    </div>\n    <script type="module" src="main.js"></script>\n  </body>\n</html>`,
  Kotlin: `import kotlinx.coroutines.*\n\ndata class Extension(\n    val id: String,\n    val name: String,\n    val version: String,\n    val installed: Boolean = false,\n)\n\nclass Registry<T : Any> {\n    private val entries = mutableMapOf<String, T>()\n\n    fun register(id: String, value: T) {\n        check(id !in entries) { "Already registered: $id" }\n        entries[id] = value\n    }\n\n    fun get(id: String): T? = entries[id]\n\n    suspend fun loadAsync(id: String, loader: suspend () -> T): T =\n        withContext(Dispatchers.IO) { loader().also { register(id, it) } }\n}`,
  Svelte: `<script lang="ts">\n  let name = $state("World");\n  let count = $state(0);\n  let doubled = $derived(count * 2);\n\n  function greet() {\n    count++;\n  }\n<\/script>\n\n<main>\n  <h1>Hello, {name}!</h1>\n  <p>Clicked {count} times &mdash; doubled: {doubled}</p>\n  <button onclick={greet}>Click me</button>\n  {#if count > 5}\n    <p class="note">You really like clicking.</p>\n  {/if}\n</main>\n\n<style>\n  main { font-family: sans-serif; padding: 2rem; }\n  h1   { color: var(--accent); margin-bottom: 0.5rem; }\n  .note { opacity: 0.6; font-style: italic; }\n<\/style>`,
};

// Canonical order — web (TS/JS/Svelte/HTML), systems (Rust/Go), scripting (Python), JVM (Java/Kotlin), data (JSON/XML)
const DEFAULT_PREVIEW_LANGS = ["TypeScript", "JavaScript", "Svelte", "HTML", "Rust", "Go", "Python", "Java", "Kotlin", "JSON", "XML"];

// ---------------------------------------------------------------------------
// Theme preview block — language dropdown + syntax-coloured code preview
// ---------------------------------------------------------------------------

const PREVIEW_LANGUAGES = ["TypeScript", "JavaScript", "Svelte", "HTML", "Rust", "Go", "Python", "Java", "Kotlin", "JSON", "XML"];

type TokenKind = "keyword" | "string" | "number" | "comment" | "type" | "fn" | "default";

const KEYWORD_SETS: Record<string, RegExp> = {
  TypeScript:  /\b(interface|type|const|let|var|function|class|async|await|return|import|export|from|if|throw|new|extends|implements|void|string|number|boolean|null|undefined|true|false|Promise)\b/g,
  JavaScript:  /\b(const|let|var|function|class|async|await|return|import|export|from|if|throw|new|true|false|null|undefined)\b/g,
  Rust:        /\b(pub|fn|let|mut|struct|impl|use|return|if|self|for|in|match|Some|None|Ok|Err|true|false|String|HashMap|Vec|Option|Result)\b/g,
  Python:      /\b(def|class|import|from|return|if|else|elif|for|in|True|False|None|self|raise|with|as|not|and|or|yield|async|await)\b/g,
  Go:          /\b(package|import|func|var|type|struct|interface|return|if|else|for|range|make|new|defer|go|chan|map|true|false|nil|sync|string|error)\b/g,
  Java:        /\b(public|private|class|interface|void|return|new|import|static|final|if|throws|String|Optional|Map|HashMap)\b/g,
  Kotlin:      /\b(fun|val|var|class|data|interface|object|companion|when|is|in|return|import|package|private|public|override|suspend|null|true|false|String|Int|Boolean|List|Map|check|withContext)\b/g,
  HTML:        /\b(DOCTYPE|html|head|body|div|span|h1|h2|h3|p|a|img|input|button|form|ul|ol|li|meta|link|script|style|main|section|header|footer|nav|article|class|id|href|src|type|lang|charset|onclick)\b/g,
  Svelte:      /\b(let|const|function|if|else|each|await|import|export|from|\$state|\$derived|\$effect|script|style|main|div|span|button|h1|p|true|false|null)\b/g,
  JSON:        /null|true|false/g,
  XML:         /</g,
};

function tokenise(code: string, lang: string): Array<{ text: string; kind: TokenKind }> {
  const tokens: Array<{ text: string; kind: TokenKind }> = [];
  let rest = code;

  while (rest.length > 0) {
    const lineComment = rest.match(/^(\/\/[^\n]*|#[^\n]*)/);
    if (lineComment) { tokens.push({ text: lineComment[0], kind: "comment" }); rest = rest.slice(lineComment[0].length); continue; }
    const blockComment = rest.match(/^\/\*[\s\S]*?\*\//);
    if (blockComment) { tokens.push({ text: blockComment[0], kind: "comment" }); rest = rest.slice(blockComment[0].length); continue; }
    const xmlComment = rest.match(/^<!--[\s\S]*?-->/);
    if (xmlComment) { tokens.push({ text: xmlComment[0], kind: "comment" }); rest = rest.slice(xmlComment[0].length); continue; }
    const strMatch = rest.match(/^(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
    if (strMatch) { tokens.push({ text: strMatch[0], kind: "string" }); rest = rest.slice(strMatch[0].length); continue; }
    const numMatch = rest.match(/^\b\d+(\.\d+)?\b/);
    if (numMatch) { tokens.push({ text: numMatch[0], kind: "number" }); rest = rest.slice(numMatch[0].length); continue; }
    const kwRe = KEYWORD_SETS[lang];
    if (kwRe) {
      kwRe.lastIndex = 0;
      const m = kwRe.exec(rest);
      if (m && m.index === 0) { tokens.push({ text: m[0], kind: "keyword" }); rest = rest.slice(m[0].length); continue; }
    }
    const typeMatch = rest.match(/^[A-Z][A-Za-z0-9_<>]*/);
    if (typeMatch) { tokens.push({ text: typeMatch[0], kind: "type" }); rest = rest.slice(typeMatch[0].length); continue; }
    const fnMatch = rest.match(/^([a-z_][a-zA-Z0-9_]*)(?=\s*\()/);
    if (fnMatch) { tokens.push({ text: fnMatch[0], kind: "fn" }); rest = rest.slice(fnMatch[0].length); continue; }
    tokens.push({ text: rest[0], kind: "default" });
    rest = rest.slice(1);
  }
  return tokens;
}

function ThemePreview(props: { entry: MarketplaceEntry }) {
  const themes = () => props.entry.item.manifest.contributes?.themes ?? [];
  const isColorTheme = () => props.entry.item.manifest.categories.includes("Color Theme");
  // Always show preview for colour themes; show for others only if previews are defined
  const hasPreview = () => isColorTheme() && themes().length > 0;

  const [activeLang, setActiveLang] = createSignal(PREVIEW_LANGUAGES[0]);
  const [themeDef, setThemeDef] = createSignal<ThemeDef | null>(null);
  const [loading, setLoading] = createSignal(false);

  const loadTheme = async () => {
    const t = themes()[0];
    if (!t) return;

    // Bundled themes are already in the registry — use them directly (no network needed)
    if (!props.entry.repoUrl) {
      const existing = getThemeDef(t.id);
      if (existing) setThemeDef(existing);
      return;
    }

    setLoading(true);
    try {
      const url = rawFileUrl(props.entry.repoUrl, props.entry.item.folderPath, t.path);
      if (!url) return;
      const res = await fetch(url, { cache: "no-cache" });
      if (res.ok) setThemeDef(await res.json() as ThemeDef);
    } catch { /* preview unavailable */ }
    setLoading(false);
  };

  let fetched = false;
  createEffect(() => {
    if (!fetched && hasPreview()) { fetched = true; loadTheme(); }
  });

  const previewCode = () => {
    const lang = activeLang();
    // Try manifest-defined previews first
    for (const t of themes()) {
      if (t.previews?.[lang]) return t.previews[lang];
    }
    // Fallback to first available manifest preview language
    for (const t of themes()) {
      if (t.previews) {
        const first = Object.entries(t.previews)[0];
        if (first) { setActiveLang(first[0]); return first[1]; }
      }
    }
    // Final fallback: built-in default snippets
    const defaultCode = DEFAULT_PREVIEW[lang];
    if (defaultCode) return defaultCode;
    const firstDefault = DEFAULT_PREVIEW_LANGS[0];
    setActiveLang(firstDefault);
    return DEFAULT_PREVIEW[firstDefault] ?? "";
  };

  const availableLangs = () => {
    // Prefer manifest-declared languages; fall back to defaults for colour themes
    const langs: string[] = [];
    for (const t of themes()) {
      for (const lang of Object.keys(t.previews ?? {})) {
        if (!langs.includes(lang)) langs.push(lang);
      }
    }
    return langs.length > 0 ? langs : (isColorTheme() ? DEFAULT_PREVIEW_LANGS : []);
  };

  const def = () => themeDef();

  const previewStyle = () => {
    const d = def();
    if (!d) return {};
    return { background: d.editor.bg, color: d.editor.fg };
  };

  const tokenColor = (kind: TokenKind): string => {
    const d = def();
    if (!d) return "";
    const s = d.syntax;
    switch (kind) {
      case "keyword":  return s.keyword?.color ?? s.controlKeyword?.color ?? "";
      case "string":   return s.string?.color ?? "";
      case "number":   return s.number?.color ?? "";
      case "comment":  return s.comment?.color ?? "";
      case "type":     return s.type?.color ?? "";
      case "fn":       return s.function?.color ?? "";
      default:         return d.editor.fg;
    }
  };

  return (
    <Show when={hasPreview()}>
      <div class="mkt-preview-block">
        <div class="mkt-preview-header">
          <span class="mkt-preview-label">Preview</span>
          <div class="mkt-preview-langs">
            <For each={availableLangs()}>
              {(lang) => (
                <button
                  class={`mkt-preview-lang${activeLang() === lang ? " active" : ""}`}
                  onClick={() => setActiveLang(lang)}
                >{lang}</button>
              )}
            </For>
          </div>
          <Show when={loading()}>
            <span class="mkt-preview-loading">loading colours…</span>
          </Show>
        </div>
        <pre class="mkt-preview-code" style={previewStyle()}>
          <Show when={def()} fallback={<code style={{ color: "var(--text-dim)" }}>{previewCode()}</code>}>
            <code>
              <For each={tokenise(previewCode(), activeLang())}>
                {(tok) => (
                  <span style={{ color: tokenColor(tok.kind) || undefined }}>{tok.text}</span>
                )}
              </For>
            </code>
          </Show>
        </pre>
      </div>
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Markdown → sanitized HTML renderer.
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end !== -1) {
        out += `<code>${escHtml(s.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    out += s[i++];
  }
  return out
    .replace(/\*\*([^*\n]{1,200})\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]{1,100})\*/g, "<em>$1</em>");
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const parts: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      parts.push(`<pre><code>${escHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.startsWith("|") && i + 1 < lines.length && /^\|[\s\-|:]+\|/.test(lines[i + 1])) {
      const header = line.split("|").filter(Boolean);
      i += 2;
      const th = header.map((c) => `<th>${inlineMd(c.trim())}</th>`).join("");
      const trs: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].split("|").filter(Boolean);
        const td = cells.map((c) => `<td>${inlineMd(c.trim())}</td>`).join("");
        trs.push(`<tr>${td}</tr>`);
        i++;
      }
      parts.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs.join("")}</tbody></table>`);
      continue;
    }

    if (line.startsWith("### ")) { parts.push(`<h3>${inlineMd(line.slice(4))}</h3>`); i++; continue; }
    if (line.startsWith("## "))  { parts.push(`<h2>${inlineMd(line.slice(3))}</h2>`); i++; continue; }
    if (line.startsWith("# "))   { parts.push(`<h1>${inlineMd(line.slice(2))}</h1>`); i++; continue; }

    if (line.startsWith("> ")) {
      parts.push(`<blockquote>${inlineMd(line.slice(2))}</blockquote>`);
      i++; continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("* "))) {
        items.push(`<li>${inlineMd(lines[i].slice(2))}</li>`);
        i++;
      }
      parts.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (line.trim() === "") { i++; continue; }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith(">") &&
      !lines[i].startsWith("- ") &&
      !lines[i].startsWith("* ") &&
      !lines[i].startsWith("|") &&
      !lines[i].startsWith("```")
    ) {
      paraLines.push(inlineMd(lines[i]));
      i++;
    }
    if (paraLines.length > 0) parts.push(`<p>${paraLines.join(" ")}</p>`);
  }

  return parts.join("\n");
}

function safeRenderMarkdown(md: string): string {
  try { return renderMarkdown(md); } catch { return `<pre>${escHtml(md)}</pre>`; }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MarketplaceSection() {
  const [filterCat, setFilterCat] = createSignal<ExtensionCategory | "All">("All");
  const [selected, setSelected] = createSignal<MarketplaceEntry | null>(null);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [search, setSearch] = createSignal("");
  const [showInstalled, setShowInstalled] = createSignal(false);
  const [installing, setInstalling] = createSignal<string | null>(null);
  const [installFailed, setInstallFailed] = createSignal<string | null>(null);
  const [entries] = createResource(refreshKey, fetchAllEntries);

  // Clear live preview when leaving the marketplace
  onCleanup(() => setPreviewThemeDef(null));

  createEffect(() => {
    const list = filtered();
    if (list.length === 0) { setSelected(null); return; }
    // Only auto-select when nothing is selected; preserve explicit navigation.
    if (!selected()) setSelected(list[0]);
  });

  const searched = createMemo(() => {
    const q = search().trim();
    let list = entries() ?? [];
    if (q) list = list.filter((e) => fuzzyMatch(q, e.item));
    if (showInstalled()) list = list.filter((e) => e.repoUrl === null || installedIds().has(e.item.manifest.id));
    return list;
  });

  const filtered = createMemo(() => {
    const cat = filterCat();
    if (cat === "All") return searched();
    // For theme/icon tabs, filter by actual contributes — prevents packs from appearing here
    // just because their declared categories list these (they contribute indirectly through members).
    if (cat === "Color Theme")     return searched().filter((e) => (e.item.manifest.contributes?.themes?.length ?? 0) > 0);
    if (cat === "File Icon Theme") return searched().filter((e) => (e.item.manifest.contributes?.iconThemes?.length ?? 0) > 0);
    if (cat === "UI Icon Theme")   return searched().filter((e) => (e.item.manifest.contributes?.uiIconPacks?.length ?? 0) > 0);
    if (cat === "Extension Pack")  return searched().filter((e) => (e.item.manifest.extensionPack?.length ?? 0) > 0);
    if (cat === "Other") {
      return searched().filter((e) =>
        e.item.manifest.categories.includes("Other") ||
        e.item.manifest.categories.every((c) => !KNOWN_CATS.has(c))
      );
    }
    return searched().filter((e) => e.item.manifest.categories.includes(cat as ExtensionCategory));
  });

  const counts = createMemo(() => {
    const all = searched();
    const map: Record<string, number> = { All: all.length };
    // Theme/icon counts mirror the contributes-based filtering used in filtered()
    map["Color Theme"]     = all.filter(e => (e.item.manifest.contributes?.themes?.length ?? 0) > 0).length;
    map["File Icon Theme"] = all.filter(e => (e.item.manifest.contributes?.iconThemes?.length ?? 0) > 0).length;
    map["UI Icon Theme"]   = all.filter(e => (e.item.manifest.contributes?.uiIconPacks?.length ?? 0) > 0).length;
    map["Extension Pack"]  = all.filter(e => (e.item.manifest.extensionPack?.length ?? 0) > 0).length;
    for (const e of all) {
      for (const c of e.item.manifest.categories) {
        if (c === "Color Theme" || c === "File Icon Theme" || c === "UI Icon Theme" || c === "Extension Pack") continue;
        map[c] = (map[c] ?? 0) + 1;
      }
      if (e.item.manifest.categories.every((c) => !KNOWN_CATS.has(c))) {
        map["Other"] = (map["Other"] ?? 0) + 1;
      }
    }
    return map;
  });

  // Error detail panel is only shown when the extension's source repo has developer mode on
  const showErrorsForEntry = (me: MarketplaceEntry | null): boolean => {
    if (!me || !me.repoUrl) return false;
    const repo = registryRepos().find((r) => r.url === me.repoUrl);
    return repo?.developerMode ?? false;
  };

  async function handleInstall(e: MarketplaceEntry) {
    setInstalling(e.item.manifest.id);
    setInstallFailed(null);
    const ok = await doInstall(e);
    setInstalling(null);
    if (!ok) setInstallFailed(e.item.manifest.id);
  }

  function navigateTo(me: MarketplaceEntry) {
    setFilterCat("All");
    setSelected(me);
  }

  return (
    <div class="mkt-shell">

      {/* Search bar */}
      <div class="mkt-search-bar">
        <input
          class="mkt-search-input"
          type="search"
          placeholder="Search extensions… (@publisher: @category: @lang: @tag:)"
          value={search()}
          onInput={(e) => { setSearch(e.currentTarget.value); setSelected(null); }}
        />
        <button
          class={`mkt-filter-installed${showInstalled() ? " active" : ""}`}
          onClick={() => setShowInstalled((v) => !v)}
          title="Show installed only"
        >
          Installed
        </button>
      </div>

      {/* ── Installed extensions card grid ─────────────────────────────── */}
      <Show when={showInstalled()}>
        <div class="mkt-installed-grid">
          <Show when={installedExtensions().length === 0}>
            <div class="mkt-state">No extensions installed yet.</div>
          </Show>
          <For each={installedExtensions()}>
            {(record) => {
              const entry = () => _allEntries.find((e) => e.item.manifest.id === record.id) ?? null;
              const updateAvail = () => {
                const e = entry();
                return e && e.repoUrl ? hasUpdate(e) : false;
              };
              const enabled = () => record.enabled !== false;
              const category = record.manifest.categories?.[0] ?? "Other";

              async function toggleEnabled(): Promise<void> {
                if (enabled()) {
                  setExtensionEnabled(record.id, false);
                  if (isTauri()) await invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                } else {
                  setExtensionEnabled(record.id, true);
                  const sinxtPath = record.sinxtPath;
                  if (sinxtPath && isTauri()) {
                    await activateExtensionFromSinxt(sinxtPath, record.manifest).catch((e) => {
                      console.warn(`[Marketplace] re-enable ${record.id}:`, e);
                    });
                  }
                }
              }

              return (
                <div class={`mkt-ext-card${enabled() ? "" : " mkt-ext-card-disabled"}`}>
                  <div class="mkt-ext-card-icon">{CATEGORY_ICONS[category as ExtensionCategory] ?? "◈"}</div>
                  <div class="mkt-ext-card-body">
                    <div class="mkt-ext-card-name">
                      {record.manifest.name}
                      <span class="mkt-ext-card-version">v{record.manifest.version}</span>
                    </div>
                    <div class="mkt-ext-card-desc">{record.manifest.description}</div>
                  </div>
                  <div class="mkt-ext-card-actions">
                    <label class="mkt-ext-toggle" title={enabled() ? "Disable extension" : "Enable extension"}>
                      <input
                        type="checkbox"
                        checked={enabled()}
                        onChange={() => { void toggleEnabled(); }}
                      />
                      <span class="mkt-ext-toggle-label">{enabled() ? "Enabled" : "Disabled"}</span>
                    </label>
                    <Show when={updateAvail()}>
                      <button
                        class="settings-btn-primary mkt-ext-btn"
                        onClick={() => { const e = entry(); if (e) void handleInstall(e); }}
                      >Update</button>
                    </Show>
                    <button
                      class="settings-btn-secondary mkt-ext-btn"
                      onClick={() => {
                        // Deregister any contributed themes/icons using data from the stored record.
                        for (const theme of record.manifest.contributes?.themes ?? []) unregisterTheme(theme.id);
                        for (const iconTheme of record.manifest.contributes?.iconThemes ?? []) unregisterIconTheme(iconTheme.id);
                        for (const uiPack of record.manifest.contributes?.uiIconPacks ?? []) unregisterUiIconPack(uiPack.id);
                        for (const wp of record.manifest.contributes?.webviewPanels ?? []) unregisterToolWindow(wp.id);
                        for (const tv of record.manifest.contributes?.treeViews ?? []) unregisterToolWindow(tv.id);
                        removeExtensionLogs(record.id);
                        uninstallExtension(record.id);
                        if (isTauri()) invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                      }}
                    >Uninstall</button>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      <div class="mkt-body" style={showInstalled() ? "display:none" : ""}>

        {/* Category sidebar */}
        <aside class="mkt-sidebar">
          <div class="mkt-sidebar-head">
            <span>Categories</span>
            <button
              class="mkt-refresh"
              onClick={() => { setRefreshKey((k) => k + 1); setSelected(null); void checkUpdatesOnly(); }}
              disabled={entries.loading}
              title="Refresh"
            >↻</button>
          </div>
          <For each={CATEGORY_GROUPS}>
            {(group) => (
              <div class="mkt-cat-group">
                <Show when={group.label}>
                  <div class="mkt-cat-group-label">{group.label}</div>
                </Show>
                <For each={group.cats}>
                  {(cat) => (
                    <button
                      class={`mkt-cat-item${filterCat() === cat ? " active" : ""}`}
                      onClick={() => { setFilterCat(cat); setSelected(null); }}
                    >
                      <span class="mkt-cat-icon">{CATEGORY_ICONS[cat]}</span>
                      <span class="mkt-cat-name">{cat}</span>
                      <Show when={counts()[cat] !== undefined}>
                        <span class="mkt-cat-count">{counts()[cat]}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </aside>

        {/* Results + detail */}
        <div class="mkt-main">
          <Show when={entries.loading}>
            <div class="mkt-state">Fetching extensions…</div>
          </Show>

          <Show when={entries.error && !entries.loading}>
            <div class="mkt-state mkt-state-error">
              Could not reach registry. Check your repository configuration.
            </div>
          </Show>

          <Show when={!entries.loading && !entries.error && filtered().length === 0}>
            <div class="mkt-state">
              {search().trim()
                ? `No extensions match "${search().trim()}".`
                : showInstalled()
                ? "No extensions installed yet."
                : "No extensions in this category."}
            </div>
          </Show>

          <Show when={!entries.loading && filtered().length > 0}>
            <div class="mkt-panes">
              <div class="mkt-list">
                <For each={filtered()}>
                  {(me) => {
                    const manifest = me.item.manifest;
                    const installed = () => installedIds().has(manifest.id);
                    const isBundled = me.repoUrl === null;
                    const updateAvailable = () => installed() && !isBundled && hasUpdate(me);
                    return (
                      <button
                        class={`mkt-card${selected()?.item.manifest.id === manifest.id ? " active" : ""}`}
                        onClick={() => setSelected(me)}
                      >
                        <div class="mkt-card-icon">{CATEGORY_ICONS[manifest.categories[0]] ?? "◈"}</div>
                        <div class="mkt-card-body">
                          <div class="mkt-card-name">
                            <span class="mkt-card-name-text">{manifest.name}</span>
                            <Show when={isBundled}>
                              <span class="mkt-icon-badge mkt-icon-badge-core" title="Sindri Core">◈</span>
                            </Show>
                            <Show when={updateAvailable()}>
                              <span class="mkt-icon-badge mkt-icon-badge-update" title="Update available">↑</span>
                            </Show>
                            <Show when={installed() && !isBundled && !updateAvailable()}>
                              <span class="mkt-icon-badge mkt-icon-badge-installed" title="Installed">✓</span>
                            </Show>
                          </div>
                          <div class="mkt-card-meta">{manifest.publisher} · v{manifest.version}</div>
                          <div class="mkt-card-desc">{manifest.description}</div>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>

              <Show when={selected()} keyed>
                {(me) => (
                  <ErrorBoundary fallback={(err, reset) => showErrorsForEntry(me)
                    ? (
                      <div class="mkt-detail-error">
                        <div class="mkt-detail-error-icon">⚠</div>
                        <div class="mkt-detail-error-msg">Extension details could not be rendered.</div>
                        <code class="mkt-detail-error-code">{String(err)}</code>
                        <button class="settings-btn-secondary" onClick={reset}>Try again</button>
                      </div>
                    ) : null
                  }>
                    <ExtensionDetail
                      entry={me}
                      installing={installing() === me.item.manifest.id}
                      installFailed={installFailed() === me.item.manifest.id}
                      onInstall={() => handleInstall(me)}
                      onUninstall={() => doUninstall(me)}
                      onNavigate={navigateTo}
                    />
                  </ErrorBoundary>
                )}
              </Show>
            </div>
          </Show>
        </div>

      </div>{/* mkt-body */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extension detail pane
// ---------------------------------------------------------------------------

function ExtensionDetail(props: {
  entry: MarketplaceEntry;
  installing: boolean;
  installFailed: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onNavigate: (entry: MarketplaceEntry) => void;
}) {
  const manifest = props.entry.item.manifest;
  const isBundled = props.entry.repoUrl === null;
  const installed = () => installedIds().has(manifest.id);
  const isPack = isExtensionPack(manifest);
  // available === false means stub/WIP — no .sinxt exists yet. Absent means available.
  const needsHost = !isPack && !!manifest.main && manifest.available === false;

  // README: fetch on demand; undefined = loading, null = not found, string = content
  const [readmeContent, setReadmeContent] = createSignal<string | null | undefined>(undefined);
  createEffect(() => {
    const { repoUrl } = props.entry;
    if (!repoUrl) { setReadmeContent(null); return; }
    const url = rawFileUrl(repoUrl, props.entry.item.folderPath, "README.md");
    if (!url) { setReadmeContent(null); return; }
    fetch(url, { cache: "no-cache" })
      .then(res => res.ok ? res.text() : null)
      .then(text => setReadmeContent(text))
      .catch(() => setReadmeContent(null));
  });

  // Available version tags — filter pre-release based on the repo's showPrerelease setting
  const availableTags = () => {
    const tags = props.entry.item.tags ?? [];
    if (!props.entry.repoUrl) return tags;
    const repo = registryRepos().find((r) => r.url === props.entry.repoUrl);
    const showPre = repo?.showPrerelease ?? false;
    return showPre ? tags : tags.filter((t) => !isPrerelease(t));
  };

  const [selectedVersion, setSelectedVersion] = createSignal(
    availableTags()[0] ?? manifest.version
  );

  // Live preview: when this is a colour theme + liveThemePreview is on, fetch + apply theme
  createEffect(() => {
    const isColorTheme = manifest.categories.includes("Color Theme");
    if (!isColorTheme || !liveThemePreview()) {
      setPreviewThemeDef(null);
      return;
    }
    const themeContrib = manifest.contributes?.themes?.[0];
    if (!themeContrib) { setPreviewThemeDef(null); return; }

    // Bundled themes are already in the registry
    if (!props.entry.repoUrl) {
      const existing = getThemeDef(themeContrib.id);
      setPreviewThemeDef(existing ?? null);
      return;
    }

    const url = rawFileUrl(props.entry.repoUrl, props.entry.item.folderPath, themeContrib.path);
    if (!url) { setPreviewThemeDef(null); return; }

    fetch(url, { cache: "no-cache" })
      .then((res) => res.ok ? res.json() : null)
      .then((def) => setPreviewThemeDef(def as ThemeDef | null))
      .catch(() => setPreviewThemeDef(null));
  });

  onCleanup(() => setPreviewThemeDef(null));

  // Developer mode: shown only when the source repo has developer mode enabled
  const isDeveloperMode = () => {
    if (!props.entry.repoUrl) return false;
    const repo = registryRepos().find((r) => r.url === props.entry.repoUrl);
    return repo?.developerMode ?? false;
  };

  const contribSummary = () => {
    const c = manifest.contributes ?? {};
    const lines: string[] = [];
    if (c.themes?.length)       lines.push(`${c.themes.length} colour theme${c.themes.length > 1 ? "s" : ""}`);
    if (c.iconThemes?.length)   lines.push(`${c.iconThemes.length} icon theme${c.iconThemes.length > 1 ? "s" : ""}`);
    if (c.uiIconPacks?.length)  lines.push(`${c.uiIconPacks.length} UI icon pack${c.uiIconPacks.length > 1 ? "s" : ""}`);
    if (c.lsp?.length)          lines.push(`${c.lsp.length} language server${c.lsp.length > 1 ? "s" : ""}`);
    if (c.dap?.length)          lines.push(`${c.dap.length} debugger${c.dap.length > 1 ? "s" : ""}`);
    if (c.taskAdapters?.length) lines.push(`${c.taskAdapters.length} task adapter${c.taskAdapters.length > 1 ? "s" : ""}`);
    if (c.panels?.length)       lines.push(`${c.panels.length} panel${c.panels.length > 1 ? "s" : ""}`);
    return lines;
  };

  const packResolved = () => (manifest.extensionPack ?? []).map((id) => ({
    id,
    entry: _allEntries.find((e) => e.item.manifest.id === id) ?? null,
  }));

  const packAllInstalled = () => packResolved().every(
    ({ entry }) => entry && (entry.repoUrl === null || installedIds().has(entry.item.manifest.id))
  );

  // Flat list of all pack members including sub-pack members, with depth for visual indentation.
  const packMembersDeep = createMemo(() => {
    function resolve(ids: string[], depth: number): Array<{ id: string; entry: MarketplaceEntry | null; depth: number }> {
      const result: Array<{ id: string; entry: MarketplaceEntry | null; depth: number }> = [];
      for (const id of ids) {
        const entry = _allEntries.find((e) => e.item.manifest.id === id) ?? null;
        result.push({ id, entry, depth });
        if (entry && (entry.item.manifest.extensionPack?.length ?? 0) > 0 && depth < 2) {
          result.push(...resolve(entry.item.manifest.extensionPack!, depth + 1));
        }
      }
      return result;
    }
    return resolve(manifest.extensionPack ?? [], 0);
  });

  // Packs/collections that declare this extension as a member
  const parentEntries = () => _allEntries.filter(e => e.item.manifest.extensionPack?.includes(manifest.id));

  // "Apply theme" only if direct members actually carry theme contributes.
  // Collections' direct members are sub-packs with contributes:{} → some() = false.
  // This avoids depending on manifest.type (absent from old GitHub manifests) or packKind.
  const isThemePack = () => isPack && packResolved().some(({ entry }) => entry && (
    (entry.item.manifest.contributes?.themes?.length ?? 0) > 0 ||
    (entry.item.manifest.contributes?.iconThemes?.length ?? 0) > 0 ||
    (entry.item.manifest.contributes?.uiIconPacks?.length ?? 0) > 0
  ));

  function applyThemePack() {
    for (const { entry } of packResolved()) {
      if (!entry) continue;
      const c = entry.item.manifest.contributes;
      if (c?.themes?.[0])      setUiTheme(c.themes[0].id);
      if (c?.iconThemes?.[0])  setIconTheme(c.iconThemes[0].id);
      if (c?.uiIconPacks?.[0]) setUiPack(c.uiIconPacks[0].id);
    }
  }

  return (
    <div class="mkt-detail">

      {/* Top section: header + actions + description + preview — scrolls with the rest */}
      <div class="mkt-detail-fixed-top">
      <div class="mkt-detail-top">
        <div class="mkt-detail-icon">{CATEGORY_ICONS[manifest.categories[0]] ?? "◈"}</div>
        <div class="mkt-detail-head">
          <div class="mkt-detail-name">{manifest.name}</div>
          <div class="mkt-detail-pub-row">
            <span class="mkt-detail-pub">{manifest.publisher}</span>
            <Show when={availableTags().length > 1} fallback={<span class="mkt-detail-pub"> · v{manifest.version}</span>}>
              <select
                class="mkt-version-select"
                value={selectedVersion()}
                onChange={(e) => setSelectedVersion(e.currentTarget.value)}
              >
                <For each={availableTags()}>
                  {(tag) => <option value={tag}>{tag}</option>}
                </For>
              </select>
            </Show>
          </div>
          <div class="mkt-detail-cats">
            <For each={manifest.categories}>
              {(cat) => <span class="mkt-detail-cat">{cat}</span>}
            </For>
            <Show when={isBundled}>
              <span class="mkt-detail-cat mkt-detail-cat-bundled">Sindri Core</span>
            </Show>
          </div>
        </div>
      </div>

      <div class="mkt-detail-actions">
        <Show when={isBundled}>
          <div class="mkt-detail-bundled-note">Bundled with Sindri — always available</div>
        </Show>
        <Show when={!isBundled && !needsHost && !isPack && !installed()}>
          <button
            class="settings-btn-primary mkt-install-btn"
            disabled={props.installing}
            onClick={props.onInstall}
          >
            {props.installing ? "Installing…" : "Install"}
          </button>
        </Show>
        <Show when={!isBundled && !needsHost && !isPack && installed()}>
          <div class="mkt-installed-row">
            <span class="mkt-installed-label">✓ Installed</span>
            <button class="settings-btn-secondary" onClick={props.onUninstall}>Uninstall</button>
          </div>
        </Show>
        <Show when={!isBundled && isPack && !packAllInstalled()}>
          <button
            class="settings-btn-primary mkt-install-btn"
            disabled={props.installing}
            onClick={props.onInstall}
          >
            {props.installing ? "Installing pack…" : "Install Pack"}
          </button>
        </Show>
        <Show when={!isBundled && isPack && packAllInstalled()}>
          <div class="mkt-installed-row">
            <span class="mkt-installed-label">✓ Pack installed</span>
            <Show when={isThemePack()}>
              <button class="settings-btn-primary" onClick={applyThemePack}>Apply theme</button>
            </Show>
            <button class="settings-btn-secondary" onClick={props.onUninstall}>Remove</button>
          </div>
        </Show>
        <Show when={needsHost}>
          <div class="mkt-detail-host-note">
            Remote install coming soon — load a local build via{" "}
            <strong>Extensions &gt; Active Extension</strong>.
          </div>
        </Show>
        <Show when={props.installFailed}>
          <div class="mkt-install-error">
            Install failed — the extension bundle could not be downloaded. Check the browser console for details.
          </div>
        </Show>
        <Show when={manifest.bugs?.url || manifest.bugs?.email}>
          <a
            class="mkt-bugs-link"
            href={manifest.bugs!.url ?? `mailto:${manifest.bugs!.email}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Report issue
          </a>
        </Show>
      </div>

      <p class="mkt-detail-desc">{manifest.description}</p>
      <ThemePreview entry={props.entry} />
      </div>{/* /mkt-detail-fixed-top */}

      <Show when={readmeContent() === undefined}>
        <div class="mkt-detail-readme mkt-detail-readme-empty" style={{ opacity: "0.45" }}>Loading…</div>
      </Show>
      <Show when={readmeContent() !== undefined && !!readmeContent()}>
        <div class="mkt-detail-readme" innerHTML={safeRenderMarkdown(readmeContent() as string)} />
      </Show>
      <Show when={readmeContent() !== undefined && !readmeContent()}>
        <div class="mkt-detail-readme mkt-detail-readme-empty">No description provided.</div>
      </Show>

      <div class="mkt-detail-meta">
        <Show when={isPack && packMembersDeep().length > 0}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Includes</div>
            <div class="mkt-pack-members">
              <For each={packMembersDeep()}>
                {({ id, entry, depth }) => {
                  const memberInstalled = () => entry && (entry.repoUrl === null || installedIds().has(id));
                  return (
                    <button
                      class={`mkt-pack-member${!entry ? " mkt-pack-member-missing" : ""}`}
                      style={depth > 0 ? { "padding-left": `${10 + depth * 18}px`, "border-left": "2px solid var(--border-subtle)" } : {}}
                      disabled={!entry}
                      onClick={() => entry && props.onNavigate(entry)}
                    >
                      <span class="mkt-pack-member-icon">
                        {entry ? (CATEGORY_ICONS[entry.item.manifest.categories[0]] ?? "◈") : "⚠"}
                      </span>
                      <span class="mkt-pack-member-name">
                        {entry ? entry.item.manifest.name : id}
                        <Show when={!entry}><span class="mkt-pack-member-unresolved"> (not found)</span></Show>
                      </span>
                      <Show when={entry}>
                        <span class="mkt-pack-member-version">v{entry!.item.manifest.version}</span>
                        <Show when={memberInstalled()}>
                          <span class="mkt-badge mkt-badge-installed" style={{ "font-size": "9px", padding: "1px 5px" }}>Installed</span>
                        </Show>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        <Show when={parentEntries().length > 0}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Included in</div>
            <div class="mkt-pack-members">
              <For each={parentEntries()}>
                {(parent) => (
                  <button
                    class="mkt-pack-member"
                    onClick={() => props.onNavigate(parent)}
                  >
                    <span class="mkt-pack-member-icon">{CATEGORY_ICONS[parent.item.manifest.categories[0]] ?? "◈"}</span>
                    <span class="mkt-pack-member-name">{parent.item.manifest.name}</span>
                    <span class="mkt-pack-member-version">v{parent.item.manifest.version}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Contributes section: only shown in developer mode — end users don't need raw contribution metadata */}
        <Show when={isDeveloperMode() && contribSummary().length > 0}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Contributes <span class="mkt-devmode-tag">dev</span></div>
            <ul class="mkt-detail-contrib-list">
              <For each={contribSummary()}>{(line) => <li>{line}</li>}</For>
            </ul>
          </div>
        </Show>

        <Show when={manifest.languages?.length}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Languages</div>
            <div class="mkt-detail-tags">
              <For each={manifest.languages}>{(l) => <span class="mkt-detail-tag">{l}</span>}</For>
            </div>
          </div>
        </Show>

        <Show when={manifest.tags?.length}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Tags</div>
            <div class="mkt-detail-tags">
              <For each={manifest.tags}>{(t) => <span class="mkt-detail-tag">{t}</span>}</For>
            </div>
          </div>
        </Show>

        <div class="mkt-detail-section">
          <div class="mkt-detail-section-label">Permissions</div>
          <Show
            when={(manifest.permissions ?? []).length > 0}
            fallback={<p class="mkt-detail-none">None</p>}
          >
            <div class="mkt-detail-perms">
              <For each={manifest.permissions}>{(p) => <code class="mkt-detail-perm">{p}</code>}</For>
            </div>
          </Show>
        </div>

        <Show when={manifest.license || (manifest.credits && manifest.credits.length > 0)}>
          <div class="mkt-detail-section">
            <div class="mkt-detail-section-label">Credits &amp; Licenses</div>
            <Show when={manifest.license}>
              <div class="mkt-detail-license-row">
                <span class="mkt-detail-license-label">Extension license</span>
                <code class="mkt-detail-spdx">{manifest.license}</code>
              </div>
            </Show>
            <Show when={manifest.credits?.length}>
              <div class="mkt-detail-credits">
                <For each={manifest.credits}>
                  {(credit) => (
                    <div class="mkt-detail-credit">
                      <div class="mkt-detail-credit-header">
                        <Show when={credit.url} fallback={<span class="mkt-detail-credit-name">{credit.name}</span>}>
                          <a class="mkt-detail-credit-name mkt-detail-credit-link" href={credit.url} target="_blank" rel="noreferrer">{credit.name}</a>
                        </Show>
                        <Show when={credit.spdx}>
                          <code class="mkt-detail-spdx">{credit.spdx}</code>
                        </Show>
                      </div>
                      <Show when={credit.notice}>
                        <p class="mkt-detail-credit-notice">{credit.notice}</p>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
