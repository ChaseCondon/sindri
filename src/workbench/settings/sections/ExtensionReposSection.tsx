import { createSignal, createResource, For, Show } from "solid-js";
import {
  registryRepos, addRepo, removeRepo,
  toggleRepoPrerelease, toggleRepoDeveloperMode,
} from "../store";
import { getRegistryClient } from "../../../extensions/registry-client";

function validateRepoUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return "URL is required";
  if (!url.startsWith("https://")) return "Must start with https://";
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "Must point to a repository — e.g. https://github.com/owner/repo";
    return null;
  } catch {
    return "Invalid URL";
  }
}

export function ExtensionReposSection() {
  const [newUrl, setNewUrl] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [urlError, setUrlError] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function submitAdd() {
    const url = newUrl().trim();
    const err = validateRepoUrl(url);
    if (err) { setUrlError(err); return; }
    addRepo(url);
    setNewUrl("");
    setAdding(false);
    setUrlError(null);
  }

  function onUrlInput(val: string) {
    setNewUrl(val);
    if (urlError()) setUrlError(validateRepoUrl(val));
  }

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">Extension Repositories</h2>
      <p class="settings-section-desc">
        Repositories are git repos. Sindri fetches each repo's <code>index.json</code> to discover extensions.
      </p>

      <div class="settings-repo-list">
        <For each={registryRepos()}>
          {(repo) => {
            const [meta] = createResource(() => repo.url, (url) => getRegistryClient().fetchMeta(url));

            return (
              <div class="settings-repo-item">
                <div
                  class="settings-repo-row settings-repo-row-clickable"
                  onClick={() => toggleExpand(repo.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(repo.id); } }}
                >
                  <div class="settings-repo-info">
                    <div class="settings-repo-label-stack">
                      <span class="settings-repo-name">{meta()?.name ?? repo.url}</span>
                      <Show when={meta()?.name}>
                        <span class="settings-repo-url-secondary">{repo.url}</span>
                      </Show>
                    </div>
                    <Show when={repo.trusted}><span class="settings-repo-badge">first-party</span></Show>
                    <Show when={repo.showPrerelease}>
                      <span class="settings-repo-badge settings-repo-badge-prerelease">pre-release</span>
                    </Show>
                    <Show when={repo.developerMode}>
                      <span class="settings-repo-badge settings-repo-badge-errors">dev</span>
                    </Show>
                  </div>
                  <div class="settings-repo-actions">
                    <Show when={!repo.trusted}>
                      <button
                        class="settings-repo-btn"
                        onClick={(e) => { e.stopPropagation(); removeRepo(repo.id); }}
                      >Remove</button>
                    </Show>
                    <span
                      class={`settings-repo-expand-btn${expanded().has(repo.id) ? " open" : ""}`}
                      aria-expanded={expanded().has(repo.id)}
                    >›</span>
                  </div>
                </div>
                <Show when={expanded().has(repo.id)}>
                  <div class="settings-repo-drawer">
                    <Show when={meta()?.description}>
                      <p class="settings-repo-meta-desc">{meta()?.description}</p>
                    </Show>
                    <Show when={meta()?.homepage}>
                      <div class="settings-repo-meta-item">
                        <a class="settings-repo-meta-link" href={meta()?.homepage} target="_blank" rel="noopener noreferrer">{meta()?.homepage}</a>
                      </div>
                    </Show>
                    <label class="settings-checkbox-label settings-repo-drawer-item">
                      <input
                        type="checkbox"
                        class="settings-checkbox"
                        checked={!!repo.showPrerelease}
                        onChange={() => toggleRepoPrerelease(repo.id)}
                      />
                      Get pre-release / beta extensions
                    </label>
                    <label class="settings-checkbox-label settings-repo-drawer-item">
                      <input
                        type="checkbox"
                        class="settings-checkbox"
                        checked={!!repo.developerMode}
                        onChange={() => toggleRepoDeveloperMode(repo.id)}
                      />
                      Enable developer mode
                      <span class="settings-repo-devmode-hint"> — shows a "Contributes" section and error stack traces in the marketplace for extensions from this repo. Intended for extension authors testing their own registry.</span>
                    </label>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <Show
        when={adding()}
        fallback={
          <button class="settings-btn-secondary" onClick={() => setAdding(true)}>+ Add repository</button>
        }
      >
        <div class="settings-repo-add">
          <div class="settings-repo-add-row">
            <input
              class={`settings-input${urlError() ? " settings-input-error" : ""}`}
              type="url"
              placeholder="https://github.com/owner/repo"
              value={newUrl()}
              onInput={(e) => onUrlInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd();
                if (e.key === "Escape") { setAdding(false); setNewUrl(""); setUrlError(null); }
              }}
              autofocus
            />
            <button class="settings-btn-primary" onClick={submitAdd}>Add</button>
            <button class="settings-btn-secondary" onClick={() => { setAdding(false); setNewUrl(""); setUrlError(null); }}>Cancel</button>
          </div>
          <Show when={urlError()}>
            <div class="settings-field-error">{urlError()}</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
