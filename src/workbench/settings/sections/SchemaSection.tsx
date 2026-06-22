// Schema-driven settings section (ADR-0023)
// Fields with the same groupTitle are rendered together in a card group.
import { For, Show } from "solid-js";
import { get as cfgGet, set as cfgSet } from "../configStore";
import type { ConfigurationSchema, ConfigurationField } from "../../../extensions/manifest";
import { SettingsRow } from "./primitives";

function keyLabel(key: string): string {
  const segment = key.split(".").pop() ?? key;
  return segment.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function SchemaField(props: { settingKey: string; field: ConfigurationField }) {
  const { settingKey: key, field } = props;

  const label = field.title ?? keyLabel(key);

  if (field.type === "boolean") {
    return (
      <SettingsRow label={label} description={field.description}>
        <label class="settings-checkbox-label">
          <input
            type="checkbox"
            class="settings-checkbox"
            checked={cfgGet<boolean>(key)}
            onChange={(e) => cfgSet(key, e.currentTarget.checked)}
          />
        </label>
      </SettingsRow>
    );
  }

  if (field.type === "enum") {
    const opts = field.enum ?? [];
    const labels = field.enumLabels ?? opts;
    if (field.presentation === "radio") {
      return (
        <SettingsRow label={label} description={field.description}>
          <div class="settings-radio-group">
            <For each={opts}>
              {(val, i) => (
                <label class="settings-radio-label">
                  <input
                    type="radio"
                    name={key}
                    class="settings-radio"
                    value={val}
                    checked={cfgGet<string>(key) === val}
                    onChange={() => cfgSet(key, val)}
                  />
                  {labels[i()]}
                </label>
              )}
            </For>
          </div>
        </SettingsRow>
      );
    }
    return (
      <SettingsRow label={label} description={field.description}>
        <select
          class="settings-select"
          value={cfgGet<string>(key)}
          onChange={(e) => cfgSet(key, e.currentTarget.value)}
        >
          <For each={opts}>{(val, i) => <option value={val}>{labels[i()]}</option>}</For>
        </select>
      </SettingsRow>
    );
  }

  if (field.type === "number") {
    if (field.presentation === "range") {
      return (
        <SettingsRow label={label} description={field.description}>
          <div class="settings-range-row">
            <input
              type="range"
              class="settings-range"
              value={cfgGet<number>(key)}
              min={field.minimum ?? 0}
              max={field.maximum ?? 1}
              step={field.step ?? 0.05}
              onInput={(e) => cfgSet(key, e.currentTarget.valueAsNumber)}
            />
            <span class="settings-range-value">{Math.round(cfgGet<number>(key) * 100)}%</span>
          </div>
        </SettingsRow>
      );
    }
    return (
      <SettingsRow label={label} description={field.description}>
        <input
          type="number"
          class="settings-input"
          value={cfgGet<number>(key)}
          min={field.minimum}
          max={field.maximum}
          step={field.step}
          onInput={(e) => cfgSet(key, e.currentTarget.valueAsNumber)}
        />
      </SettingsRow>
    );
  }

  return (
    <SettingsRow label={label} description={field.description}>
      <input
        type="text"
        class="settings-input"
        value={cfgGet<string>(key)}
        onInput={(e) => cfgSet(key, e.currentTarget.value)}
      />
    </SettingsRow>
  );
}

export function SchemaSection(props: { title: string; schema: ConfigurationSchema }) {
  type Entry = { key: string; field: ConfigurationField };
  type Group = { title: string | undefined; entries: Entry[] };

  const groups = (): Group[] => {
    const sorted = Object.entries(props.schema)
      .sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999));
    const result: Group[] = [];
    for (const [key, field] of sorted) {
      const last = result[result.length - 1];
      if (!last || (field.groupTitle !== undefined && field.groupTitle !== last.title)) {
        result.push({ title: field.groupTitle, entries: [{ key, field }] });
      } else {
        last.entries.push({ key, field });
      }
    }
    return result;
  };

  return (
    <div class="settings-section">
      <h2 class="settings-section-title">{props.title}</h2>
      <For each={groups()}>
        {(group) => (
          <div class={group.title !== undefined ? "settings-group" : undefined}>
            <Show when={group.title !== undefined}>
              <div class="settings-group-header">{group.title}</div>
            </Show>
            <For each={group.entries}>
              {({ key, field }) => (
                <Show when={!field.when || cfgGet<boolean>(field.when)}>
                  <SchemaField settingKey={key} field={field} />
                </Show>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
