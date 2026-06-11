// Registry client seam — ADR-0020 §5
// Mirrors getCoreClient() / CoreClient pattern from src/lib/tauri.ts (ADR-0017).
// TauriRegistryClient  — two-stage .sinxt download: GitHub Release asset → committed raw file
// BrowserRegistryClient — no-op (cannot write to app_data_dir from the browser)
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/tauri";
import type { ExtensionManifest, RegistryIndex, RegistryIndexEntry, RegistryLeanIndex } from "./manifest";
import type { IconThemeDef, IconSource, IconSourceRef, UiIconPackDef } from "../theme/tokens";

export interface RegistryClient {
  readonly transport: "tauri" | "browser";

  // Fetch (and optionally refresh) the index from a registry URL.
  // Returns the parsed index or null if unreachable.
  fetchIndex(repoUrl: string): Promise<RegistryIndex | null>;

  // Fetch only the repo-level metadata (name, description, homepage) from index.json.
  // Lighter than fetchIndex — does not fetch individual manifest.json files.
  fetchMeta(repoUrl: string): Promise<{ name?: string; description?: string; homepage?: string } | null>;

  // Download, install, and activate a specific extension version from a registry repo.
  // Returns the absolute path to the installed .sinxt file, or null on failure.
  downloadExtension(entry: RegistryIndexEntry, version: string, repoUrl: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Browser implementation — raw fetch of index.json
// ---------------------------------------------------------------------------

class BrowserRegistryClient implements RegistryClient {
  readonly transport = "browser" as const;

  async fetchIndex(repoUrl: string): Promise<RegistryIndex | null> {
    const rawUrl = toRawIndexUrl(repoUrl);
    if (!rawUrl) return null;
    try {
      const res = await fetch(rawUrl, { cache: "no-cache" });
      if (!res.ok) return null;
      const lean = (await res.json()) as RegistryLeanIndex;
      return await enrichLeanIndex(lean, repoUrl);
    } catch {
      return null;
    }
  }

  async fetchMeta(repoUrl: string): Promise<{ name?: string; description?: string; homepage?: string } | null> {
    const rawUrl = toRawIndexUrl(repoUrl);
    if (!rawUrl) return null;
    try {
      const res = await fetch(rawUrl, { cache: "no-cache" });
      if (!res.ok) return null;
      const { name, description, homepage } = (await res.json()) as RegistryLeanIndex;
      return { name, description, homepage };
    } catch {
      return null;
    }
  }

  async downloadExtension(_entry: RegistryIndexEntry, _version: string, _repoUrl: string): Promise<string | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tauri implementation — delegates to Rust for git operations
// ---------------------------------------------------------------------------

class TauriRegistryClient implements RegistryClient {
  readonly transport = "tauri" as const;

  async fetchIndex(repoUrl: string): Promise<RegistryIndex | null> {
    const rawUrl = toRawIndexUrl(repoUrl);
    if (!rawUrl) return null;
    try {
      const res = await fetch(rawUrl, { cache: "no-cache" });
      if (!res.ok) return null;
      const lean = (await res.json()) as RegistryLeanIndex;
      return await enrichLeanIndex(lean, repoUrl);
    } catch {
      return null;
    }
  }

  async fetchMeta(repoUrl: string): Promise<{ name?: string; description?: string; homepage?: string } | null> {
    const rawUrl = toRawIndexUrl(repoUrl);
    if (!rawUrl) return null;
    try {
      const res = await fetch(rawUrl, { cache: "no-cache" });
      if (!res.ok) return null;
      const { name, description, homepage } = (await res.json()) as RegistryLeanIndex;
      return { name, description, homepage };
    } catch {
      return null;
    }
  }

  async downloadExtension(entry: RegistryIndexEntry, version: string, repoUrl: string): Promise<string | null> {
    const { id } = entry.manifest;
    const assetName = `${id}-${version}.sinxt`;

    // Stage 1: GitHub Release asset for tag `{id}-v{version}`
    const releaseUrl = toReleaseAssetUrl(repoUrl, `${id}-v${version}`, assetName);
    if (releaseUrl) {
      const bytes = await fetchBytes(releaseUrl);
      if (bytes) return installSinxtBytes(id, version, bytes);
    }

    // Stage 2: committed artifact at dist/<id>-<version>.sinxt in the registry repo
    const rawUrl = rawFileUrl(repoUrl, entry.folderPath, `dist/${assetName}`);
    if (rawUrl) {
      const bytes = await fetchBytes(rawUrl);
      if (bytes) return installSinxtBytes(id, version, bytes);
    }

    console.error(`[TauriRegistryClient] no installable .sinxt found for ${id}@${version}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lean index enrichment
// ---------------------------------------------------------------------------

async function fetchManifestEntry(folderPath: string, repoUrl: string): Promise<RegistryIndexEntry | null> {
  const url = rawFileUrl(repoUrl, folderPath, "manifest.json");
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    const manifest = (await res.json()) as ExtensionManifest;
    return { manifest, tags: [`v${manifest.version}`], folderPath };
  } catch {
    return null;
  }
}

// Discover and fetch member extensions of packs/collections.
// Derives candidate paths from extensionPack IDs using a two-step convention:
//   1. {pack-folder}/{id-name-part}            e.g. aurora-theme-pack/aurora-theme
//   2. {pack-folder}/sindri-{id-name-part}     fallback for extensions with sindri- prefix
// Both are attempted in parallel; 404s are silently ignored. Results are deduped.
// Recurses up to MAX_DEPTH to handle collections containing sub-packs.
const MAX_MEMBER_DEPTH = 3;

async function discoverMembers(
  packEntries: RegistryIndexEntry[],
  repoUrl: string,
  depth: number,
): Promise<RegistryIndexEntry[]> {
  if (depth > MAX_MEMBER_DEPTH || packEntries.length === 0) return [];

  // Build candidate paths for all member IDs
  const candidatePaths: string[] = [];
  for (const pack of packEntries) {
    const memberIds = pack.manifest.extensionPack ?? [];
    for (const memberId of memberIds) {
      const namePart = memberId.split(".")[1] ?? memberId;
      candidatePaths.push(`${pack.folderPath}/${namePart}`);
      candidatePaths.push(`${pack.folderPath}/sindri-${namePart}`);
    }
  }

  if (candidatePaths.length === 0) return [];

  const fetched = await Promise.all(candidatePaths.map(p => fetchManifestEntry(p, repoUrl)));
  const valid = fetched.filter((e): e is RegistryIndexEntry => e !== null);

  // Deduplicate by folderPath (both candidate variants may resolve to the same entry)
  const seen = new Set<string>();
  const deduped = valid.filter(e => {
    if (seen.has(e.folderPath)) return false;
    seen.add(e.folderPath);
    return true;
  });

  // Recurse into any sub-packs found
  const subPacks = deduped.filter(e => (e.manifest.extensionPack?.length ?? 0) > 0);
  const subMembers = await discoverMembers(subPacks, repoUrl, depth + 1);

  return [...deduped, ...subMembers];
}

// Fetch each manifest.json in parallel and assemble the full RegistryIndex.
// Packs and collections are then walked recursively to fetch their members.
async function enrichLeanIndex(lean: RegistryLeanIndex, repoUrl: string): Promise<RegistryIndex> {
  // Legacy flat format
  if (lean.extensionFolders) {
    const results = await Promise.all(lean.extensionFolders.map(fp => fetchManifestEntry(fp, repoUrl)));
    return results.filter((e): e is RegistryIndexEntry => e !== null);
  }

  const standalonePaths = lean.extensions ?? [];
  const packPaths       = lean.packs ?? [];
  const collPaths       = lean.collections ?? [];
  const allTopPaths     = [...standalonePaths, ...packPaths, ...collPaths];

  const topEntries = (await Promise.all(allTopPaths.map(fp => fetchManifestEntry(fp, repoUrl))))
    .filter((e): e is RegistryIndexEntry => e !== null);

  // Auto-discover members of packs and collections
  const packCollectionPaths = new Set([...packPaths, ...collPaths]);
  const packEntries = topEntries.filter(e => packCollectionPaths.has(e.folderPath));
  const memberEntries = await discoverMembers(packEntries, repoUrl, 1);

  // Deduplicate across top-level + member entries (in case a standalone is also a pack member)
  const seen = new Set<string>(topEntries.map(e => e.folderPath));
  const freshMembers = memberEntries.filter(e => {
    if (seen.has(e.folderPath)) return false;
    seen.add(e.folderPath);
    return true;
  });

  return [...topEntries, ...freshMembers];
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Download helpers (used by TauriRegistryClient.downloadExtension)
// ---------------------------------------------------------------------------

// Build the GitHub Release asset download URL for a given tag and asset filename.
// Returns null for non-GitHub repos (handled by the raw-file fallback).
function toReleaseAssetUrl(repoUrl: string, tag: string, assetName: string): string | null {
  const gh = repoUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(\.git)?$/);
  if (!gh) return null;
  return `https://github.com/${gh[1]}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

// Fetch a URL and return its bytes, or null on any network/HTTP error.
async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Write .sinxt bytes to app_data_dir via the Rust install_sinxt command.
// Returns the installed .sinxt path, or null on failure.
async function installSinxtBytes(id: string, version: string, bytes: Uint8Array): Promise<string | null> {
  try {
    return await invoke<string>("install_sinxt", {
      extId: id,
      version,
      bytes: Array.from(bytes),
    });
  } catch (e) {
    console.error("[registry-client] install_sinxt failed:", e);
    return null;
  }
}

// Build the raw base URL for a repo (without trailing slash, without filename).
function toRawBaseUrl(repoUrl: string): string | null {
  const gh = repoUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(\.git)?$/);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/main`;

  const gl = repoUrl.match(/^https?:\/\/gitlab\.com\/([^/]+\/[^/]+?)(\.git)?$/);
  if (gl) return `https://gitlab.com/${gl[1]}/-/raw/main`;

  // Generic — use URL as-is, stripped of trailing slash
  try {
    return new URL(repoUrl).toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function toRawIndexUrl(repoUrl: string): string | null {
  const base = toRawBaseUrl(repoUrl);
  return base ? `${base}/index.json` : null;
}

// Build a raw URL for a specific file within an extension folder.
// folderPath + filePath are both relative to the repo root.
export function rawFileUrl(repoUrl: string, folderPath: string, filePath: string): string | null {
  const base = toRawBaseUrl(repoUrl);
  return base ? `${base}/${folderPath}/${filePath}` : null;
}

// Resolve an IconThemeDef whose icons map may use IconSourceRef (path-based)
// into a fully-inline IconThemeDef ready for registerIconTheme().
// iconJsonUrl is the URL the icons.json was fetched from (for resolving relative paths).
export async function resolveIconThemeDef(
  raw: Record<string, unknown>,
  iconJsonUrl: string
): Promise<IconThemeDef> {
  const basePath = iconJsonUrl.substring(0, iconJsonUrl.lastIndexOf("/") + 1);
  const icons: Record<string, IconSource> = {};
  const rawIcons = raw.icons as Record<string, { svg?: string; path?: string; monoSvg?: string; monoPath?: string }>;

  await Promise.all(
    Object.entries(rawIcons).map(async ([id, src]) => {
      let svg = src.svg ?? "";
      let monoSvg = src.monoSvg;

      if (src.path && !svg) {
        try {
          const res = await fetch(`${basePath}${src.path}`, { cache: "no-cache" });
          if (res.ok) svg = await res.text();
        } catch { /* leave empty */ }
      }
      if (src.monoPath && !monoSvg) {
        try {
          const res = await fetch(`${basePath}${src.monoPath}`, { cache: "no-cache" });
          if (res.ok) monoSvg = await res.text();
        } catch { /* leave empty */ }
      }

      icons[id] = monoSvg ? { svg, monoSvg } : { svg };
    })
  );

  return { ...(raw as unknown as IconThemeDef), icons };
}

// Resolve a UiIconPackDef whose icons map may use path-based sources into inline SVG strings.
// packJsonUrl is the URL the ui-pack.json was fetched from (for resolving relative paths).
export async function resolveUiIconPackDef(
  raw: Record<string, unknown>,
  packJsonUrl: string
): Promise<UiIconPackDef> {
  const basePath = packJsonUrl.substring(0, packJsonUrl.lastIndexOf("/") + 1);
  const icons: Record<string, string> = {};
  const rawIcons = raw.icons as Record<string, { svg?: string; path?: string }>;

  await Promise.all(
    Object.entries(rawIcons).map(async ([id, src]) => {
      let svg = src.svg ?? "";
      if (src.path && !svg) {
        try {
          const res = await fetch(`${basePath}${src.path}`, { cache: "no-cache" });
          if (res.ok) svg = await res.text();
        } catch { /* leave empty */ }
      }
      icons[id] = svg;
    })
  );

  return { ...(raw as unknown as UiIconPackDef), icons };
}

// Suppress unused import warning — IconSourceRef is the on-disk type documented in tokens.ts
void (undefined as unknown as IconSourceRef);

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _client: RegistryClient | null = null;

export function getRegistryClient(): RegistryClient {
  if (!_client) {
    _client = isTauri() ? new TauriRegistryClient() : new BrowserRegistryClient();
  }
  return _client;
}
