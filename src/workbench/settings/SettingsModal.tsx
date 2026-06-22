// Settings modal overlay — ADR-0021
// Core shell: modal focus-traps, ESC closes. Nav has collapsible groups.
import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { previewThemeDef } from "./store";
import { EDITOR_DECORATIONS_SCHEMA } from "./configStore";
import { MarketplaceSection } from "./marketplace/MarketplaceSection";
import { GeneralSection } from "./sections/GeneralSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { SchemaSection } from "./sections/SchemaSection";
import { LanguagePacksSection } from "./sections/LanguagePacksSection";
import { ActiveExtensionSection } from "./sections/ActiveExtensionSection";
import { ExtensionReposSection } from "./sections/ExtensionReposSection";
import { ExtensionPrefsSection } from "./sections/ExtensionPrefsSection";
import { TerminalSection } from "./sections/TerminalSection";

export { SettingsGroup, SettingsRow } from "./sections/primitives";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "editor"
  | "terminal"
  | "extensions-active"
  | "extensions-repos"
  | "extensions-prefs"
  | "marketplace"
  | "language-packs";

interface NavSection { id: SettingsSectionId; label: string }
interface NavGroup { id: string; label: string; sections: NavSection[] }

const NAV_GROUPS: NavGroup[] = [
  {
    id: "general",
    label: "General",
    sections: [
      { id: "general", label: "General" },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    sections: [
      { id: "appearance", label: "Themes & Icons" },
      { id: "editor", label: "Editor" },
      { id: "terminal", label: "Terminal" },
    ],
  },
  {
    id: "languages",
    label: "Languages",
    sections: [
      { id: "language-packs", label: "Language Packs" },
    ],
  },
  {
    id: "extensions",
    label: "Extensions",
    sections: [
      { id: "extensions-active", label: "Install Extension" },
      { id: "extensions-repos",  label: "Repositories" },
      { id: "extensions-prefs",  label: "Marketplace Preferences" },
      { id: "marketplace",       label: "Marketplace" },
    ],
  },
];

interface Props { onClose: () => void }

export function SettingsModal(props: Props) {
  const [activeSection, setActiveSection] = createSignal<SettingsSectionId>("appearance");
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  let backdropRef!: HTMLDivElement;
  let closeRef!: HTMLButtonElement;
  let dialogRef!: HTMLDivElement;

  onMount(() => {
    closeRef?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  // Live theme preview: apply/clear CSS vars on the dialog element
  createEffect(() => {
    const def = previewThemeDef();
    const dialog = dialogRef;
    if (!dialog) return;
    if (!def) {
      const toRemove: string[] = [];
      for (let i = 0; i < dialog.style.length; i++) {
        const prop = dialog.style.item(i);
        if (prop.startsWith("--")) toRemove.push(prop);
      }
      toRemove.forEach((p) => dialog.style.removeProperty(p));
      return;
    }
    for (const [token, value] of Object.entries(def.ui))   dialog.style.setProperty(token, value);
    for (const [token, value] of Object.entries(def.glow)) dialog.style.setProperty(token, value);
  });

  function toggleGroup(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === backdropRef) props.onClose();
  }

  return (
    <div class="settings-backdrop" ref={backdropRef} onClick={onBackdropClick}>
      <div class="settings-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Settings">

        <div class="settings-header">
          <span class="settings-title">Settings</span>
          <button class="settings-close" ref={closeRef} onClick={props.onClose} aria-label="Close">✕</button>
        </div>

        <div class="settings-body">
          <nav class="settings-nav">
            <For each={NAV_GROUPS}>
              {(group) => (
                <>
                  <button
                    class="settings-nav-group-header"
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span class={`settings-nav-chevron${collapsed().has(group.id) ? " collapsed" : ""}`}>›</span>
                    {group.label}
                  </button>
                  <Show when={!collapsed().has(group.id)}>
                    <For each={group.sections}>
                      {(sec) => (
                        <button
                          class={`settings-nav-item${activeSection() === sec.id ? " active" : ""}`}
                          onClick={() => setActiveSection(sec.id)}
                        >
                          {sec.label}
                        </button>
                      )}
                    </For>
                  </Show>
                </>
              )}
            </For>
          </nav>

          <div class="settings-content">
            <Show when={activeSection() === "general"}>
              <GeneralSection />
            </Show>
            <Show when={activeSection() === "appearance"}>
              <AppearanceSection />
            </Show>
            <Show when={activeSection() === "editor"}>
              <SchemaSection title="Editor" schema={EDITOR_DECORATIONS_SCHEMA} />
            </Show>
            <Show when={activeSection() === "terminal"}>
              <TerminalSection />
            </Show>
            <Show when={activeSection() === "language-packs"}>
              <LanguagePacksSection onBrowse={() => setActiveSection("marketplace")} />
            </Show>
            <Show when={activeSection() === "extensions-active"}>
              <ActiveExtensionSection />
            </Show>
            <Show when={activeSection() === "extensions-repos"}>
              <ExtensionReposSection />
            </Show>
            <Show when={activeSection() === "extensions-prefs"}>
              <ExtensionPrefsSection />
            </Show>
            <Show when={activeSection() === "marketplace"}>
              <MarketplaceSection />
            </Show>
          </div>
        </div>

      </div>
    </div>
  );
}
