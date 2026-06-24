// Marketplace data layer — ADR-0020 §3 / §7
// Signals, types, fetching, install/uninstall, and startup rehydration.
import { createSignal } from "solid-js";
import type { ExtensionCategory, ExtensionManifest, RegistryIndexEntry } from "../../../extensions/manifest";
import { getRegistryClient, rawFileUrl, resolveIconThemeDef, resolveUiIconPackDef } from "../../../extensions/registry-client";
import { activateExtensionFromSinxt, activateExtensionWithManifest, preRegisterManifestPanels } from "../../../extensions/activation";
import { registerTheme, unregisterTheme, registerIconTheme, unregisterIconTheme, registerUiIconPack, unregisterUiIconPack } from "../../../theme/registry";
import { unregisterToolWindow } from "../../layout";
import { removeExtensionLogs, registerExtension as registerLogChannel } from "../../panels/ext-logs-store";
import type { ThemeDef } from "../../../theme/tokens";
import {
  registryRepos, installedExtensions, installExtension, updateInstalledExtension, uninstallExtension,
  type InstalledRecord,
} from "../store";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../../lib/tauri";
import { rebroadcastActiveEditor } from "../../../editor/editor-state-bridge";
import { removeCustomEditorRegistrationsByExtId } from "../../../editor/custom-editor-registry";
import bundledExtensions from "../../../../core-extensions/bundled-extensions.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Extends RegistryIndexEntry with the source repo URL (null = bundled core)
export interface MarketplaceEntry {
  item: RegistryIndexEntry;
  repoUrl: string | null; // null for bundled core extensions
}

// ---------------------------------------------------------------------------
// Category config
// ---------------------------------------------------------------------------

export const CATEGORY_GROUPS: { label: string; cats: (ExtensionCategory | "All")[] }[] = [
  { label: "",              cats: ["All"] },
  { label: "Packs",         cats: ["Extension Pack"] },
  { label: "Themes",        cats: ["Color Theme", "File Icon Theme", "UI Icon Theme"] },
  { label: "Languages",     cats: ["Language", "Test & Task Adapter"] },
  { label: "Accessibility", cats: ["Localisation"] },
  { label: "Interface",     cats: ["UI Extension"] },
  { label: "",              cats: ["Other"] },
];

export const CATEGORY_ICONS: Partial<Record<ExtensionCategory | "All", string>> = {
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
export const KNOWN_CATS = new Set<string>([
  "Extension Pack", "Color Theme", "File Icon Theme", "UI Icon Theme",
  "Language", "Localisation", "Test & Task Adapter", "UI Extension", "Other",
]);

export function isExtensionPack(manifest: ExtensionManifest): boolean {
  return (manifest.extensionPack?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Fuzzy / tag search
// Prefix syntax:  @publisher:sindri  @category:theme  @lang:rust
// Remaining terms are fuzzy-matched against name/description
// ---------------------------------------------------------------------------

export function fuzzyMatch(query: string, entry: RegistryIndexEntry): boolean {
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

export function isPrerelease(tag: string): boolean {
  const v = tag.startsWith("v") ? tag.slice(1) : tag;
  return v.includes("-");
}

function latestStableTag(tags: string[], showPre: boolean): string | null {
  const filtered = showPre ? tags : tags.filter((t) => !isPrerelease(t));
  return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}

// Returns true if the registry has a newer version than what is installed.
export function hasUpdate(me: MarketplaceEntry): boolean {
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
// Module-level signals (reactive so installed grid updates without page refresh)
// ---------------------------------------------------------------------------

const [_allEntries, _setAllEntries] = createSignal<MarketplaceEntry[]>([]);
export const allEntries = _allEntries;
export function setAllEntries(v: MarketplaceEntry[]): void { _setAllEntries(v); }

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export async function fetchAllEntries(): Promise<MarketplaceEntry[]> {
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
  setAllEntries(merged);
  // Templates are hidden (not directly installable); all other entries including pack members
  // appear in the browse list so they can be individually discovered and installed.
  return merged.filter(e => e.item.manifest.type !== "template");
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export async function doInstall(entry: MarketplaceEntry, versionOverride?: string): Promise<boolean> {
  const { item, repoUrl } = entry;
  const { contributes, id, extensionPack } = item.manifest;

  // Extension pack — install each member; only mark pack installed if all succeed.
  if (extensionPack?.length) {
    let allOk = true;
    for (const memberId of extensionPack) {
      const memberEntry = _allEntries().find((e) => e.item.manifest.id === memberId);
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
      const baseEntry = _allEntries().find((e) => e.item.manifest.id === item.manifest.extends);
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
    // ADR-0040: non-blocking engine compat check — warn but still install.
    if (isTauri()) {
      const enginesRange = item.manifest.engines?.sindri ?? null;
      const compat = await invoke<{ ok: boolean; reason?: string; message?: string }>(
        "ext_check_compat", { engines: enginesRange }
      ).catch((): { ok: boolean; reason?: string; message?: string } => ({ ok: true }));
      if (!compat.ok) {
        console.warn(`[Marketplace] engine compatibility warning for ${id}: ${compat.message}`);
      }
    }
    const client = getRegistryClient();
    const targetVersion = versionOverride ?? item.manifest.version;
    const isSpecificVersion = !!versionOverride && versionOverride !== item.manifest.version;
    const sinxtPath = await client.downloadExtension(
      item, targetVersion, repoUrl,
      isSpecificVersion ? targetVersion : undefined,
    );
    if (sinxtPath) {
      const isUpdate = installedExtensions().some((r) => r.id === id);
      if (isUpdate) {
        // Deactivate the old isolate before activating the new sinxt so there
        // are no duplicate editorOpenRequest listeners from the old version.
        if (isTauri()) await invoke("ext_deactivate", { extId: id }).catch(() => {});
        updateInstalledExtension(id, item.manifest, sinxtPath);
      } else {
        installExtension(id, repoUrl, item.folderPath, item.manifest, sinxtPath);
      }
      await activateExtensionFromSinxt(sinxtPath, item.manifest);
      return true;
    }
    console.error(`[Marketplace] failed to download .sinxt for ${id}`);
    return false;
  }

  if (repoUrl) installExtension(id, repoUrl, item.folderPath, item.manifest);
  return true;
}

export function doUninstall(entry: MarketplaceEntry): void {
  const { item } = entry;
  const { contributes, id, extensionPack } = item.manifest;

  if (extensionPack?.length) {
    for (const memberId of extensionPack) {
      const memberEntry = _allEntries().find((e) => e.item.manifest.id === memberId);
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
  removeCustomEditorRegistrationsByExtId(id);
  removeExtensionLogs(id);
  uninstallExtension(id);
  if (isTauri()) invoke("ext_deactivate", { extId: id }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Re-registration on reload (called from App.tsx at startup)
// ---------------------------------------------------------------------------

export async function rehydrateInstalledExtensions(): Promise<void> {
  // Pass 1 — synchronous: register log channels AND pre-register tool windows for
  // all enabled extensions so activity bar icons AND log channels appear on the
  // very first render, before any async activation completes.
  for (const record of installedExtensions()) {
    if (record.enabled === false) continue;
    if (record.manifest.id) {
      registerLogChannel(
        record.manifest.id,
        record.manifest.name ?? record.manifest.id,
        record.manifest.categories ?? ["Other"],
      );
    }
    preRegisterManifestPanels(record.manifest);
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
  setAllEntries([...coreEntries, ...[...repoIndexes.values()].flat()]);

  for (const record of needsNetwork) {
    const entry = _allEntries().find((e) => e.item.manifest.id === record.id);
    if (!entry || entry.repoUrl === null) continue;
    await reinstallEntry(entry);
  }

  // All extensions have activated and registered their onDidChangeActiveEditor
  // handlers. Re-broadcast the current editor state so they don't need a tab
  // switch to read the file that was already open on startup.
  rebroadcastActiveEditor();
}

async function reinstallEntry(entry: MarketplaceEntry): Promise<void> {
  const { item, repoUrl } = entry;
  const { contributes, extensionPack } = item.manifest;
  if (!repoUrl) return;

  if (extensionPack?.length) {
    for (const memberId of extensionPack) {
      const memberEntry = _allEntries().find((e) => e.item.manifest.id === memberId);
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
      const baseEntry = _allEntries().find((e) => e.item.manifest.id === item.manifest.extends);
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
