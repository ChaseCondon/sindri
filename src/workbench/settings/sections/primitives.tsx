import { Show } from "solid-js";

export function SettingsGroup(props: { title: string; children: unknown }) {
  return (
    <div class="settings-group">
      <div class="settings-group-header">{props.title}</div>
      {props.children as any}
    </div>
  );
}

export function SettingsRow(props: { label: string; description?: string; children: unknown }) {
  return (
    <div class="settings-row">
      <div class="settings-row-label">
        <span class="settings-row-name">{props.label}</span>
        <Show when={props.description}>
          <span class="settings-row-desc">{props.description}</span>
        </Show>
      </div>
      <div class="settings-row-control">{props.children as any}</div>
    </div>
  );
}
