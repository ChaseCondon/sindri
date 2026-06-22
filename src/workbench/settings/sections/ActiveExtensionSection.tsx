import { createSignal, createMemo, For, Show } from "solid-js";
import {
  installedExtensions, installExtension, uninstallExtension,
  updateInstalledExtension, loadDevExtension, setLocalSinxtAlt,
  switchExtensionVariant, activeSinxtPath, activeManifest, setExtensionEnabled,
} from "../store";
import { activateExtensionFromSinxt, activateExtensionWithManifest } from "../../../extensions/activation";
import { deregisterExtDecorations } from "../../../editor/editor-state-bridge";
import { unregisterToolWindow } from "../../layout";
import { removeExtensionLogs } from "../../panels/ext-logs-store";
import type { ExtensionManifest } from "../../../extensions/manifest";
import { isTauri } from "../../../lib/tauri";

type InstallStatus =
  | { kind: "ok"; name: string; version: string }
  | { kind: "err"; msg: string };

export function ActiveExtensionSection() {
  const [activeTab, setActiveTab] = createSignal<"installed" | "dev">("installed");
  const [loadingSource, setLoadingSource] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);
  const [status, setStatus] = createSignal<InstallStatus | null>(null);
  const [debuggerUrls, setDebuggerUrls] = createSignal<Map<string, string>>(new Map());

  const devExtensions = () => installedExtensions().filter((r) => r.repoUrl === "dev");
  const localExts = () => installedExtensions().filter((r) => r.repoUrl === "local");
  const marketplaceExts = () => installedExtensions().filter(
    (r) => (r.repoUrl !== "dev" && r.repoUrl !== "local") || (r.repoUrl === "dev" && !!r.savedPreDev),
  );

  async function handleLoadFromSource() {
    setStatus(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Extension Manifest", extensions: ["json"] }],
      title: "Select manifest.json",
    });
    if (!selected || typeof selected !== "string") return;
    const dir = selected.replace(/[/\\][^/\\]*$/, "") || selected;
    setLoadingSource(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ manifest_json: string; dev_dir: string }>(
        "ext_load_from_source",
        { dir },
      );
      const manifest = JSON.parse(result.manifest_json) as ExtensionManifest;
      if (!manifest.id) throw new Error("manifest.json missing 'id'");
      loadDevExtension(manifest.id, selected, manifest);
      await activateExtensionWithManifest(`${result.dev_dir}/extension.js`);
      setStatus({ kind: "ok", name: manifest.name ?? manifest.id, version: manifest.version ?? "" });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setLoadingSource(false);
    }
  }

  async function handleInstallFromFile() {
    setStatus(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Sindri Extension", extensions: ["sinxt"] }],
    });
    if (!selected || typeof selected !== "string") return;
    setInstalling(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ sinxt_path: string; manifest_json: string }>(
        "install_sinxt_from_path",
        { path: selected },
      );
      const manifest = JSON.parse(result.manifest_json) as ExtensionManifest;
      if (!manifest.id) throw new Error("manifest.json missing 'id'");
      const existing = installedExtensions().find((r) => r.id === manifest.id);
      if (existing && existing.repoUrl !== "local" && existing.repoUrl !== "dev") {
        setLocalSinxtAlt(manifest.id, result.sinxt_path, manifest);
      } else if (existing) {
        updateInstalledExtension(manifest.id, manifest, result.sinxt_path);
      } else {
        installExtension(manifest.id, "local", "", manifest, result.sinxt_path);
      }
      await activateExtensionFromSinxt(result.sinxt_path, manifest);
      setStatus({ kind: "ok", name: manifest.name ?? manifest.id, version: manifest.version ?? "" });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setInstalling(false);
    }
  }

  async function handleRemoveDev(id: string) {
    deregisterExtDecorations(id);
    const restored = uninstallExtension(id);
    setDebuggerUrls((prev) => { const m = new Map(prev); m.delete(id); return m; });
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      invoke("ext_stop_dev_watch", { extId: id }).catch(() => {});
      if (restored) {
        const sinxt = activeSinxtPath(restored);
        const mf = activeManifest(restored);
        if (sinxt) activateExtensionFromSinxt(sinxt, mf).catch(() => {});
      }
    }
  }

  async function handleAttachDebugger(id: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      const wsUrl = await invoke<string>("ext_attach_debugger", { extId: id });
      setDebuggerUrls((prev) => new Map([...prev, [id, wsUrl]]));
    } catch (e) {
      alert(`Attach debugger failed: ${e}`);
    }
  }

  async function handleStopDebugger(id: string) {
    setDebuggerUrls((prev) => { const m = new Map(prev); m.delete(id); return m; });
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      invoke("ext_stop_debugger", { extId: id }).catch(() => {});
    }
  }

  function handleCopyDebugUrl(url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
  }

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Extensions</h2>

      {/* Tab bar */}
      <div class="ext-tabs">
        <button
          class={`ext-tab${activeTab() === "installed" ? " active" : ""}`}
          onClick={() => setActiveTab("installed")}
        >
          Installed Extensions
        </button>
        <button
          class={`ext-tab${activeTab() === "dev" ? " active" : ""}`}
          onClick={() => setActiveTab("dev")}
        >
          Dev Extensions
        </button>
      </div>

      {/* ── Installed Extensions tab ────────────────────────────────────────── */}
      <Show when={activeTab() === "installed"}>
        <p class="settings-section-desc">
          Extensions installed from the marketplace or a local <code>.sinxt</code> package.
        </p>

        {/* Locally installed */}
        <h3 class="settings-subsection-title">From file</h3>
        <Show when={localExts().length > 0} fallback={
          <div class="ext-active-empty">No locally installed extensions.</div>
        }>
          <div class="ext-installed-list">
            <For each={localExts()}>
              {(record) => {
                const enabled = createMemo(() => {
                  const current = installedExtensions().find((r) => r.id === record.id);
                  return current?.enabled !== false;
                });
                async function toggleEnabled() {
                  if (enabled()) {
                    setExtensionEnabled(record.id, false);
                    for (const wp of record.manifest.contributes?.webviewPanels ?? []) unregisterToolWindow(wp.id);
                    for (const tv of record.manifest.contributes?.treeViews ?? []) unregisterToolWindow(tv.id);
                    removeExtensionLogs(record.id);
                    if (isTauri()) {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                    }
                  } else {
                    setExtensionEnabled(record.id, true);
                    const sinxt = record.sinxtPath;
                    if (sinxt && isTauri()) activateExtensionFromSinxt(sinxt, record.manifest).catch(() => {});
                  }
                }
                return (
                  <div class={`ext-installed-card${enabled() ? "" : " ext-installed-card--disabled"}`}>
                    <div class="ext-installed-card-header">
                      <span class="ext-installed-card-name">{record.manifest.name ?? record.id}</span>
                      <span class="ext-active-badge">v{record.manifest.version ?? "?"}</span>
                      <div class="ext-installed-card-actions">
                        <button
                          class={`ext-installed-toggle${enabled() ? " ext-installed-toggle--on" : ""}`}
                          onClick={toggleEnabled}
                          title={enabled() ? "Disable extension" : "Enable extension"}
                        >
                          {enabled() ? "Enabled" : "Disabled"}
                        </button>
                        <button
                          class="settings-btn-secondary settings-btn-secondary--compact"
                          onClick={async () => {
                            deregisterExtDecorations(record.id);
                            for (const wp of record.manifest.contributes?.webviewPanels ?? []) unregisterToolWindow(wp.id);
                            for (const tv of record.manifest.contributes?.treeViews ?? []) unregisterToolWindow(tv.id);
                            removeExtensionLogs(record.id);
                            uninstallExtension(record.id);
                            if (isTauri()) {
                              const { invoke } = await import("@tauri-apps/api/core");
                              await invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                            }
                          }}
                        >
                          Uninstall
                        </button>
                      </div>
                    </div>
                    <Show when={record.manifest.description}>
                      <p class="ext-installed-card-desc">{record.manifest.description}</p>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={isTauri()}>
          <div class="ext-active-actions">
            <button
              class="settings-btn-secondary"
              disabled={installing()}
              title="Install a pre-built .sinxt extension package from your local disk."
              onClick={handleInstallFromFile}
            >
              {installing() ? "Installing…" : "Install from .sinxt…"}
            </button>
          </div>
        </Show>

        {/* Marketplace installed */}
        <Show when={marketplaceExts().length > 0}>
          <h3 class="settings-subsection-title settings-subsection-title--spaced">From marketplace</h3>
          <div class="ext-installed-list">
            <For each={marketplaceExts()}>
              {(record) => {
                const isDevOverridden = record.repoUrl === "dev";
                const displayManifest = isDevOverridden && record.savedPreDev
                  ? record.savedPreDev.manifest
                  : record.manifest;
                const enabled = createMemo(() => {
                  const current = installedExtensions().find((r) => r.id === record.id);
                  return current?.enabled !== false;
                });
                const activeVariant = () => record.activeVariant ?? "marketplace";

                async function toggleEnabled() {
                  if (enabled()) {
                    setExtensionEnabled(record.id, false);
                    const mf = displayManifest;
                    for (const wp of mf.contributes?.webviewPanels ?? []) unregisterToolWindow(wp.id);
                    for (const tv of mf.contributes?.treeViews ?? []) unregisterToolWindow(tv.id);
                    removeExtensionLogs(record.id);
                    if (isTauri()) {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                    }
                  } else {
                    setExtensionEnabled(record.id, true);
                    const sinxt = record.sinxtPath;
                    if (sinxt && isTauri()) activateExtensionFromSinxt(sinxt, record.manifest).catch(() => {});
                  }
                }
                async function handleSwitch(variant: "marketplace" | "local") {
                  switchExtensionVariant(record.id, variant);
                  const sinxt = variant === "local" && record.localSinxtAlt
                    ? record.localSinxtAlt.sinxtPath
                    : record.sinxtPath;
                  const mf = variant === "local" && record.localSinxtAlt
                    ? record.localSinxtAlt.manifest
                    : record.manifest;
                  if (sinxt) await activateExtensionFromSinxt(sinxt, mf).catch(() => {});
                }

                return (
                  <div class={`ext-installed-card${enabled() && !isDevOverridden ? "" : " ext-installed-card--disabled"}`}>
                    <div class="ext-installed-card-header">
                      <span class="ext-installed-card-name">{displayManifest.name ?? record.id}</span>
                      <Show when={isDevOverridden}
                        fallback={
                          <Show when={record.localSinxtAlt}
                            fallback={<span class="ext-active-badge">v{displayManifest.version ?? "?"}</span>}
                          >
                            <select
                              class="ext-variant-select"
                              value={activeVariant()}
                              onChange={(e) => handleSwitch(e.currentTarget.value as "marketplace" | "local")}
                            >
                              <option value="marketplace">marketplace v{displayManifest.version ?? "?"}</option>
                              <option value="local">local .sinxt v{record.localSinxtAlt!.manifest.version ?? "?"}</option>
                            </select>
                          </Show>
                        }
                      >
                        <span class="ext-active-badge">v{displayManifest.version ?? "?"}</span>
                        <span class="ext-installed-badge--override">⚠ overridden by dev</span>
                      </Show>
                      <div class="ext-installed-card-actions">
                        <Show when={!isDevOverridden}>
                          <button
                            class={`ext-installed-toggle${enabled() ? " ext-installed-toggle--on" : ""}`}
                            onClick={toggleEnabled}
                            title={enabled() ? "Disable extension" : "Enable extension"}
                          >
                            {enabled() ? "Enabled" : "Disabled"}
                          </button>
                        </Show>
                        <Show when={isDevOverridden}
                          fallback={
                            <button
                              class="settings-btn-secondary settings-btn-secondary--compact"
                              onClick={async () => {
                                deregisterExtDecorations(record.id);
                                for (const wp of record.manifest.contributes?.webviewPanels ?? []) unregisterToolWindow(wp.id);
                                for (const tv of record.manifest.contributes?.treeViews ?? []) unregisterToolWindow(tv.id);
                                removeExtensionLogs(record.id);
                                uninstallExtension(record.id);
                                if (isTauri()) {
                                  const { invoke } = await import("@tauri-apps/api/core");
                                  await invoke("ext_deactivate", { extId: record.id }).catch(() => {});
                                }
                              }}
                            >
                              Uninstall
                            </button>
                          }
                        >
                          <span class="ext-installed-dev-note">Manage in Dev tab</span>
                        </Show>
                      </div>
                    </div>
                    <Show when={displayManifest.description}>
                      <p class="ext-installed-card-desc">{displayManifest.description}</p>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={localExts().length === 0 && marketplaceExts().length === 0}>
          <div class="ext-active-empty">No extensions installed yet. Browse the Marketplace to get started.</div>
        </Show>

        <Show when={!isTauri()}>
          <div class="langpacks-host-note">
            Extension installation requires the Tauri desktop app.
          </div>
        </Show>
      </Show>

      {/* ── Dev Extensions tab ─────────────────────────────────────────────── */}
      <Show when={activeTab() === "dev"}>
        <p class="settings-section-desc">
          Extensions loaded from source. Sindri builds and hot-reloads them on every
          file save — no packaging or manual reinstall needed.
        </p>

        <Show when={isTauri()}>
          <div class="ext-debug-help">
            <div class="ext-debug-help-title">Debugger setup</div>

            <div class="ext-debug-help-option">
              <strong>Option A — Chrome DevTools</strong>
              <ol class="ext-debug-steps">
                <li>Open <code>chrome://inspect</code> in Chrome or Edge</li>
                <li>Click <strong>Configure…</strong> and add <code>127.0.0.1:9229</code></li>
                <li>Click <strong>Attach Debugger</strong> on an extension below — it appears under <em>Remote Targets</em></li>
              </ol>
              <p class="ext-debug-help-note">Or use the <strong>Dev Tools</strong> button in the menu bar (⌘⌥I / Ctrl+Shift+I) to open the app's own inspector.</p>
            </div>

            <div class="ext-debug-help-option">
              <strong>Option B — VS Code</strong>
              <p class="ext-debug-help-note">Add to <code>.vscode/launch.json</code>:</p>
              <pre class="ext-debug-launch-json">{`{
  "type": "node",
  "request": "attach",
  "name": "Attach to Sindri extension",
  "address": "127.0.0.1",
  "port": 9229,
  "sourceMaps": true
}`}</pre>
            </div>
          </div>
        </Show>

        <Show when={devExtensions().length > 0} fallback={
          <div class="ext-active-empty">No dev extensions loaded.</div>
        }>
          <For each={devExtensions()}>
            {(record) => (
              <div class="ext-active-row ext-active-row--stack">
                <div class="ext-active-row-main">
                  <span class="ext-active-name">{record.manifest.name ?? record.id}</span>
                  <span class="ext-active-badge">v{record.manifest.version ?? "?"}</span>
                  <Show when={debuggerUrls().has(record.id)}
                    fallback={
                      <span class="ext-active-badge ext-active-badge--dev" title="Loaded from source — Sindri watches and hot-reloads on save">dev ◉</span>
                    }
                  >
                    <span class="ext-active-badge ext-active-badge--debug" title="CDP debugger session active">◉ debugging</span>
                  </Show>
                  <Show when={isTauri()}>
                    <button
                      class="settings-btn-secondary"
                      title={debuggerUrls().has(record.id) ? "Re-attach a fresh CDP session" : "Open a CDP debugger session (debug builds only)"}
                      onClick={() => handleAttachDebugger(record.id)}
                    >
                      {debuggerUrls().has(record.id) ? "Re-attach" : "Attach Debugger"}
                    </button>
                    <Show when={debuggerUrls().has(record.id)}>
                      <button
                        class="settings-btn-secondary"
                        title="Close the inspector session and return to idle mode"
                        onClick={() => handleStopDebugger(record.id)}
                      >
                        Stop
                      </button>
                    </Show>
                  </Show>
                  <button
                    class="settings-btn-secondary ext-active-uninstall"
                    onClick={() => handleRemoveDev(record.id)}
                  >
                    Remove
                  </button>
                </div>
                <Show when={debuggerUrls().get(record.id)}>
                  {(url) => (
                    <div class="ext-debug-url-row">
                      <code class="ext-debug-url">{url()}</code>
                      <button
                        class="settings-btn-secondary ext-debug-copy"
                        title="Copy WebSocket URL to clipboard"
                        onClick={() => handleCopyDebugUrl(url())}
                      >
                        Copy
                      </button>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </For>
        </Show>

        <Show when={isTauri()}>
          <div class="ext-active-actions">
            <button
              class="settings-btn-primary"
              disabled={loadingSource()}
              title="Select the manifest.json of a TypeScript extension. Sindri builds it and hot-reloads on every file save."
              onClick={handleLoadFromSource}
            >
              {loadingSource() ? "Building…" : "Load from manifest.json…"}
            </button>
          </div>
        </Show>

        <Show when={!isTauri()}>
          <div class="langpacks-host-note">
            Dev extension loading requires the Tauri desktop app.
          </div>
        </Show>
      </Show>

      {/* Status feedback — shared between tabs */}
      <Show when={status()?.kind === "ok"}>
        <div class="settings-success-note">
          {(status() as Extract<InstallStatus, { kind: "ok" }>).name}{" "}
          v{(status() as Extract<InstallStatus, { kind: "ok" }>).version} activated.
        </div>
      </Show>
      <Show when={status()?.kind === "err"}>
        <div class="settings-field-error">
          {(status() as Extract<InstallStatus, { kind: "err" }>).msg}
        </div>
      </Show>
    </div>
  );
}
