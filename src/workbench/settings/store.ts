// Settings store — ADR-0021
// Core shell: registry repos, installed extensions, locale, live-preview flag.
// Editor feature settings (rainbow brackets, indent guides) moved to configStore (ADR-0023).
import { createSignal, createMemo } from "solid-js";
import type { ExtensionManifest } from "../../extensions/manifest";
import type { ThemeDef } from "../../theme/tokens";

// ---------------------------------------------------------------------------
// Registry repository config (ADR-0020 §3)
// ---------------------------------------------------------------------------

export interface RegistryRepo {
  id: string;
  url: string;
  trusted: boolean;
  showPrerelease?: boolean;  // show beta/nightly tags from this repo
  developerMode?: boolean;   // unlock dev features: error details, future: local install, reload
}

// A secondary installation of the same extension from a different source.
export interface SinxtAlt {
  sinxtPath: string;
  manifest: ExtensionManifest;
}

// Full record stored per installed extension so we can re-register on reload.
export interface InstalledRecord {
  id: string;
  repoUrl: string;       // "dev" | "local" | marketplace URL
  folderPath: string;
  manifest: ExtensionManifest;
  sinxtPath?: string;    // absolute path to .sinxt; present for marketplace/local installs

  // When repoUrl === "dev": the non-dev record that was active before this dev load.
  // Restored automatically when the dev extension is removed.
  savedPreDev?: {
    repoUrl: string;
    folderPath: string;
    manifest: ExtensionManifest;
    sinxtPath?: string;
    activeVariant?: "marketplace" | "local";
    localSinxtAlt?: SinxtAlt;
  };

  // For marketplace records: an alternative local .sinxt the user can activate instead.
  localSinxtAlt?: SinxtAlt;
  // Which variant is running. Only meaningful when localSinxtAlt is set.
  // Defaults to "marketplace" when absent.
  activeVariant?: "marketplace" | "local";
}

/** Return the sinxtPath that should currently be active for a record. */
export function activeSinxtPath(record: InstalledRecord): string | undefined {
  if (record.activeVariant === "local" && record.localSinxtAlt) {
    return record.localSinxtAlt.sinxtPath;
  }
  return record.sinxtPath;
}

/** Return the manifest that should currently be active for a record. */
export function activeManifest(record: InstalledRecord): ExtensionManifest {
  if (record.activeVariant === "local" && record.localSinxtAlt) {
    return record.localSinxtAlt.manifest;
  }
  return record.manifest;
}

const STORAGE_KEY = "sindri:settings";

interface PersistedSettings {
  registryRepos: RegistryRepo[];
  installedExtensions: InstalledRecord[];
  liveThemePreview: boolean;
  locale: string;
}

function load(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<PersistedSettings & { installedIds?: string[] }>;
    // Migrate legacy installedIds (string[]) to installedExtensions (InstalledRecord[])
    const installedExtensions = parsed.installedExtensions ?? [];
    // Migrate legacy showExtensionErrors → developerMode
    const repos = (parsed.registryRepos ?? []).map((r: RegistryRepo & { showExtensionErrors?: boolean }) => {
      if (r.showExtensionErrors !== undefined && r.developerMode === undefined) {
        const { showExtensionErrors: _, ...rest } = r;
        return { ...rest, developerMode: _ };
      }
      return r;
    });
    return {
      registryRepos: repos,
      installedExtensions,
      liveThemePreview: parsed.liveThemePreview ?? false,
      locale: parsed.locale ?? "sindri.en-us",
    };
  } catch {
    return defaultSettings();
  }
}

function defaultSettings(): PersistedSettings {
  return {
    registryRepos: [],
    installedExtensions: [],
    liveThemePreview: false,
    locale: "sindri.en-us",
  };
}

function persist(s: PersistedSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* unavailable */ }
}

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

const initial = load();

const [_repos, _setRepos] = createSignal<RegistryRepo[]>(initial.registryRepos);
export const registryRepos = _repos;

const [_installedExtensions, _setInstalledExtensions] = createSignal<InstalledRecord[]>(initial.installedExtensions);
export const installedExtensions = _installedExtensions;
// Derived Set of IDs — same interface as before so all consumers keep working
export const installedIds = createMemo(() => new Set(_installedExtensions().map((r) => r.id)));

const [_liveThemePreview, _setLiveThemePreview] = createSignal<boolean>(initial.liveThemePreview ?? false);
export const liveThemePreview = _liveThemePreview;
export function setLiveThemePreview(v: boolean): void { _setLiveThemePreview(v); save(); }

const [_locale, _setLocale] = createSignal<string>(initial.locale ?? "sindri.en-us");
export const activeLocale = _locale;
export function setLocale(id: string): void { _setLocale(id); save(); }

// Non-persisted: currently previewed theme def (set by marketplace on selection)
export const [previewThemeDef, setPreviewThemeDef] = createSignal<ThemeDef | null>(null);

// Non-persisted: absolute path of the currently active extension bundle (if any)
export const [activeBundlePath, setActiveBundlePath] = createSignal<string | null>(null);

function save(): void {
  persist({
    registryRepos: _repos(),
    installedExtensions: _installedExtensions(),
    liveThemePreview: _liveThemePreview(),
    locale: _locale(),
  });
}

// ---------------------------------------------------------------------------
// Repo mutations
// ---------------------------------------------------------------------------

export function addRepo(url: string): void {
  const trimmed = url.trim();
  if (!trimmed || _repos().some((r) => r.url === trimmed)) return;
  _setRepos([..._repos(), { id: crypto.randomUUID(), url: trimmed, trusted: false }]);
  save();
}

export function removeRepo(id: string): void {
  _setRepos(_repos().filter((r) => r.id !== id));
  save();
}

export function trustRepo(id: string): void {
  _setRepos(_repos().map((r) => (r.id === id ? { ...r, trusted: true } : r)));
  save();
}

export function toggleRepoPrerelease(id: string): void {
  _setRepos(_repos().map((r) => (r.id === id ? { ...r, showPrerelease: !r.showPrerelease } : r)));
  save();
}

export function toggleRepoDeveloperMode(id: string): void {
  _setRepos(_repos().map((r) => (r.id === id ? { ...r, developerMode: !r.developerMode } : r)));
  save();
}

// ---------------------------------------------------------------------------
// Installed extension mutations
// ---------------------------------------------------------------------------

export function installExtension(
  id: string,
  repoUrl: string,
  folderPath: string,
  manifest: ExtensionManifest,
  sinxtPath?: string,
): void {
  if (_installedExtensions().some((r) => r.id === id)) return;
  _setInstalledExtensions([..._installedExtensions(), { id, repoUrl, folderPath, manifest, sinxtPath }]);
  save();
}

/**
 * Remove an extension. If it was a dev record with a savedPreDev, the pre-dev
 * record is automatically restored. Returns the restored record (if any) so the
 * caller can re-activate the appropriate sinxt.
 */
export function uninstallExtension(id: string): InstalledRecord | null {
  const record = _installedExtensions().find((r) => r.id === id);
  _setInstalledExtensions(_installedExtensions().filter((r) => r.id !== id));

  let restored: InstalledRecord | null = null;
  if (record?.repoUrl === "dev" && record.savedPreDev) {
    const pre = record.savedPreDev;
    restored = {
      id,
      repoUrl: pre.repoUrl,
      folderPath: pre.folderPath,
      manifest: pre.manifest,
      sinxtPath: pre.sinxtPath,
      activeVariant: pre.activeVariant,
      localSinxtAlt: pre.localSinxtAlt,
    };
    _setInstalledExtensions([..._installedExtensions(), restored]);
  }
  save();
  return restored;
}

export function updateInstalledExtension(
  id: string,
  manifest: ExtensionManifest,
  sinxtPath?: string,
): void {
  _setInstalledExtensions(
    _installedExtensions().map((r) => r.id === id ? { ...r, manifest, sinxtPath } : r),
  );
  save();
}

/**
 * Add or update a local .sinxt alternative for an existing marketplace record.
 * Switches activeVariant to "local" immediately so the new file is used.
 * If the record is a dev record, updates its savedPreDev instead.
 */
export function setLocalSinxtAlt(id: string, sinxtPath: string, manifest: ExtensionManifest): void {
  _setInstalledExtensions(
    _installedExtensions().map((r) => {
      if (r.id !== id) return r;
      if (r.repoUrl === "dev" && r.savedPreDev) {
        // Patch the saved pre-dev so the local alt survives a dev-remove restore.
        return { ...r, savedPreDev: { ...r.savedPreDev, localSinxtAlt: { sinxtPath, manifest }, activeVariant: "local" } };
      }
      return { ...r, localSinxtAlt: { sinxtPath, manifest }, activeVariant: "local" };
    }),
  );
  save();
}

/** Switch which variant (marketplace sinxt vs local sinxt alt) is active. */
export function switchExtensionVariant(id: string, variant: "marketplace" | "local"): void {
  _setInstalledExtensions(
    _installedExtensions().map((r) => r.id === id ? { ...r, activeVariant: variant } : r),
  );
  save();
}

/**
 * Register or replace a dev/source extension (repoUrl = "dev", folderPath = source dir).
 * Saves the previous non-dev record so it can be restored when the dev extension is removed.
 */
export function loadDevExtension(
  id: string,
  folderPath: string,
  manifest: ExtensionManifest,
): void {
  const existing = _installedExtensions().find((r) => r.id === id);
  const savedPreDev: InstalledRecord["savedPreDev"] =
    existing && existing.repoUrl !== "dev"
      ? {
          repoUrl: existing.repoUrl,
          folderPath: existing.folderPath,
          manifest: existing.manifest,
          sinxtPath: existing.sinxtPath,
          activeVariant: existing.activeVariant,
          localSinxtAlt: existing.localSinxtAlt,
        }
      : existing?.savedPreDev; // preserve if replacing one dev with another

  _setInstalledExtensions([
    ..._installedExtensions().filter((r) => r.id !== id),
    { id, repoUrl: "dev", folderPath, manifest, savedPreDev },
  ]);
  save();
}

export function isInstalled(id: string): boolean {
  return installedIds().has(id);
}
