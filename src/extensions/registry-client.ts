// Registry client seam — ADR-0020 §5
// Mirrors getCoreClient() / CoreClient pattern from src/lib/tauri.ts (ADR-0017).
// TauriRegistryClient  — fetches .sinxt from committed raw file (raw.githubusercontent.com)
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

    // GitHub Release asset URLs always fail with CORS in Tauri WebView (redirect to
    // release-assets.githubusercontent.com is blocked). Use the committed raw artifact directly.
    const rawUrl = rawFileUrl(repoUrl, entry.folderPath, `dist/${assetName}`);
    console.log(`[registry-client] downloadExtension: id=${id} version=${version} url=${rawUrl}`);
    if (rawUrl) {
      const bytes = await fetchBytes(rawUrl);
      console.log(`[registry-client] fetchBytes: ${bytes ? bytes.length + " bytes" : "null (failed)"}`);
      if (bytes) return installSinxtBytes(id, version, bytes);
    }

    console.error(`[TauriRegistryClient] no installable .sinxt found for ${id}@${version}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lean index enrichment
// ---------------------------------------------------------------------------

async function fetchManifestEntry(folderPath: string, repoUrl: string, isMember?: boolean): Promise<RegistryIndexEntry | null> {
  const url = rawFileUrl(repoUrl, folderPath, "manifest.json");
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    const manifest = (await res.json()) as ExtensionManifest;
    const entry: RegistryIndexEntry = { manifest, tags: [`v${manifest.version}`], folderPath };
    if (isMember) entry.isMember = true;
    return entry;
  } catch {
    return null;
  }
}

// ADR-0038 §3: id-based resolution from flat entries array.
// Each entry carries its own path — no guessing, no 404 probes.
async function enrichFromEntries(
  entries: Array<{ id: string; path: string; type: string }>,
  repoUrl: string,
): Promise<RegistryIndex> {
  const results = await Promise.all(entries.map(e => fetchManifestEntry(e.path, repoUrl)));
  const valid = results.filter((e): e is RegistryIndexEntry => e !== null);

  // Collect every ID that is explicitly listed in any pack's extensionPack.
  const packMemberIds = new Set<string>();
  for (const e of valid) {
    for (const id of e.manifest.extensionPack ?? []) packMemberIds.add(id);
  }

  // isMember hides entries from the top-level browse list while keeping them in _allEntries.
  // Templates are always hidden; pack-member extensions/sub-packs are also hidden.
  for (const entry of valid) {
    if (entry.manifest.type === "template" || packMemberIds.has(entry.manifest.id)) {
      entry.isMember = true;
    }
  }
  return valid;
}

// Legacy member discovery for old bucket-format registries (no `entries` field).
// Path-guesses each member by publisher-prefix then plain name; recurses into sub-packs.
// Only used when the index doesn't carry ADR-0038 `entries`.
const MAX_MEMBER_DEPTH = 3;
async function discoverMembersLegacy(
  packEntries: RegistryIndexEntry[],
  repoUrl: string,
  depth: number,
): Promise<RegistryIndexEntry[]> {
  if (depth > MAX_MEMBER_DEPTH || packEntries.length === 0) return [];

  const fetches = packEntries.flatMap(pack =>
    (pack.manifest.extensionPack ?? []).map(memberId => {
      const dotIdx = memberId.indexOf(".");
      const publisher = dotIdx >= 0 ? memberId.slice(0, dotIdx) : "";
      const namePart  = dotIdx >= 0 ? memberId.slice(dotIdx + 1) : memberId;
      const p1 = `${pack.folderPath}/${publisher ? `${publisher}-` : ""}${namePart}`;
      const p2 = `${pack.folderPath}/${namePart}`;
      return p1 === p2
        ? fetchManifestEntry(p1, repoUrl, true)
        : fetchManifestEntry(p1, repoUrl, true).then(e => e ?? fetchManifestEntry(p2, repoUrl, true));
    })
  );

  const fetched = await Promise.all(fetches);
  const valid = fetched.filter((e): e is RegistryIndexEntry => e !== null);

  const seen = new Set<string>();
  const deduped = valid.filter(e => { if (seen.has(e.folderPath)) return false; seen.add(e.folderPath); return true; });

  const subPacks = deduped.filter(e => (e.manifest.extensionPack?.length ?? 0) > 0);
  const subMembers = await discoverMembersLegacy(subPacks, repoUrl, depth + 1);
  return [...deduped, ...subMembers];
}

// Fetch each manifest.json in parallel and assemble the full RegistryIndex.
async function enrichLeanIndex(lean: RegistryLeanIndex, repoUrl: string): Promise<RegistryIndex> {
  // ADR-0038 current format — flat entries with explicit id+path+type
  if (lean.entries) {
    return enrichFromEntries(lean.entries, repoUrl);
  }

  // Legacy bucket format (backward compat — extensions/packs/collections)
  if (lean.extensions || lean.packs || lean.collections) {
    const standalonePaths = lean.extensions ?? [];
    const packPaths       = lean.packs ?? [];
    const collPaths       = lean.collections ?? [];
    const allTopPaths     = [...standalonePaths, ...packPaths, ...collPaths];
    const topEntries = (await Promise.all(allTopPaths.map(fp => fetchManifestEntry(fp, repoUrl))))
      .filter((e): e is RegistryIndexEntry => e !== null);

    // Discover pack/collection members via path-guessing (same as pre-ADR-0038 behavior)
    const packCollPaths = new Set([...packPaths, ...collPaths]);
    const packRoots = topEntries.filter(e => packCollPaths.has(e.folderPath));
    const memberEntries = await discoverMembersLegacy(packRoots, repoUrl, 1);

    const seen = new Set<string>(topEntries.map(e => e.folderPath));
    const freshMembers = memberEntries.filter(e => { if (seen.has(e.folderPath)) return false; seen.add(e.folderPath); return true; });

    return [...topEntries, ...freshMembers];
  }

  // Oldest legacy flat format (backward compat)
  if (lean.extensionFolders) {
    const results = await Promise.all(lean.extensionFolders.map(fp => fetchManifestEntry(fp, repoUrl)));
    return results.filter((e): e is RegistryIndexEntry => e !== null);
  }

  return [];
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Download helpers (used by TauriRegistryClient.downloadExtension)
// ---------------------------------------------------------------------------

// Fetch a URL and return its bytes, or null on any network/HTTP error.
async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { cache: "no-cache", signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
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
