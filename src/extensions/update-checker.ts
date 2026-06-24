import { createSignal } from "solid-js";
import { getRegistryClient } from "./registry-client";
import { installedExtensions, updateInstalledExtension } from "../workbench/settings/store";
import { activateExtensionFromSinxt } from "./activation";
import { refreshCustomEditorsByViewType } from "../editor/custom-editor-store";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/tauri";
import { get as getConfig } from "../workbench/settings/configStore";
import type { RegistryIndexEntry } from "./manifest";

// Reactive count of extensions with updates available (set by checkUpdatesOnly).
const [_pendingUpdateCount, setPendingUpdateCount] = createSignal(0);
export const pendingUpdateCount = _pendingUpdateCount;

function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

async function fetchIndexesByRepo(): Promise<Map<string, RegistryIndexEntry[]>> {
  const client = getRegistryClient();
  const repoUrls = new Set(
    installedExtensions()
      .filter((r) => r.sinxtPath && r.repoUrl)
      .map((r) => r.repoUrl),
  );
  const map = new Map<string, RegistryIndexEntry[]>();
  await Promise.all(
    [...repoUrls].map(async (url) => {
      const index = await client.fetchIndex(url);
      if (index) map.set(url, index);
    }),
  );
  return map;
}

// Called at startup after rehydrateInstalledExtensions.
// Silently downloads and activates newer versions of installed .sinxt extensions.
// Skipped entirely when extensions.autoUpdate is false.
export async function checkAndInstallUpdates(): Promise<void> {
  if (getConfig("extensions.autoUpdate") === false) {
    console.log("[update-checker] auto-update disabled — skipping");
    return;
  }

  const records = installedExtensions().filter((r) => r.sinxtPath && r.repoUrl);
  if (records.length === 0) return;

  const client = getRegistryClient();
  const indexByRepo = await fetchIndexesByRepo();

  for (const record of records) {
    const index = indexByRepo.get(record.repoUrl);
    if (!index) continue;

    const entry = index.find((e) => e.manifest.id === record.id);
    if (!entry) continue;

    const registryVersion = entry.manifest.version;
    if (!isNewer(registryVersion, record.manifest.version)) continue;

    console.log(`[update-checker] updating ${record.id} ${record.manifest.version} → ${registryVersion}`);
    const sinxtPath = await client.downloadExtension(entry, registryVersion, record.repoUrl);
    if (!sinxtPath) continue;

    // Deactivate old isolate before switching so there are no duplicate listeners.
    if (isTauri()) await invoke("ext_deactivate", { extId: record.id }).catch(() => {});

    updateInstalledExtension(record.id, entry.manifest, sinxtPath);
    await activateExtensionFromSinxt(sinxtPath, entry.manifest).catch((e) => {
      console.error(`[update-checker] failed to activate ${record.id}@${registryVersion}:`, e);
    });

    // Refresh any open custom editor tabs so they pick up the new build.
    for (const ce of (entry.manifest.contributes as { customEditors?: { viewType: string }[] } | undefined)?.customEditors ?? []) {
      refreshCustomEditorsByViewType(ce.viewType);
    }
  }
}

// Called on a 4-hour timer. Checks for updates and increments pendingUpdateCount
// without downloading anything. The badge in App.tsx reflects this count.
export async function checkUpdatesOnly(): Promise<void> {
  const records = installedExtensions().filter((r) => r.sinxtPath && r.repoUrl);
  if (records.length === 0) return;

  const indexByRepo = await fetchIndexesByRepo();
  let count = 0;

  for (const record of records) {
    const index = indexByRepo.get(record.repoUrl);
    if (!index) continue;

    const entry = index.find((e) => e.manifest.id === record.id);
    if (!entry) continue;

    if (isNewer(entry.manifest.version, record.manifest.version)) count++;
  }

  setPendingUpdateCount(count);
}
