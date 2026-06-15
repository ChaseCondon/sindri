// Extension hot-reload watcher — polls the dev dir written by `sindri ext watch`.
//
// Protocol:
//   CLI writes app_data_dir/extensions/<ext_id>/dev/extension.js + manifest.json
//   CLI touches app_data_dir/extensions/<ext_id>/dev/.watch on each successful rebuild
//   This module polls .watch mtime every 1s; on change, re-activates the extension.
//
// Only active for locally-installed extensions (repoUrl === "local") while the app
// is running in Tauri. WASM and binary assets are not refreshed by watch mode —
// those require a fresh sinxt install.
import { invoke } from "@tauri-apps/api/core";
import { installedExtensions } from "../workbench/settings/store";
import { activateExtensionWithManifest } from "./activation";
import { isTauri } from "../lib/tauri";

const lastMtimes = new Map<string, number>();

async function checkDevExtensions(): Promise<void> {
  const locals = installedExtensions().filter((r) => r.repoUrl === "local" || r.repoUrl === "dev");
  for (const record of locals) {
    try {
      const devDir = await invoke<string>("ext_dev_dir", { extId: record.id });
      const watchMarker = `${devDir}/.watch`;
      const mtime = await invoke<number>("file_mtime", { path: watchMarker });
      const prev = lastMtimes.get(record.id);

      if (prev === undefined) {
        // First time we see the marker — record it, don't reload yet.
        lastMtimes.set(record.id, mtime);
        continue;
      }

      if (mtime !== prev) {
        lastMtimes.set(record.id, mtime);
        const bundlePath = `${devDir}/extension.js`;
        console.log(`[dev-watcher] hot-reloading ${record.id}`);
        await activateExtensionWithManifest(bundlePath);
      }
    } catch {
      // .watch file does not exist — extension not in watch mode, skip silently.
    }
  }
}

export function startDevWatcher(): void {
  if (!isTauri()) return;
  setInterval(() => { checkDevExtensions().catch(() => {}); }, 1000);
}
