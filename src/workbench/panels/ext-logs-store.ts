// ADR-0030 — reactive store for the Extension Logs panel.
// Channels are registered at extension activation time (before any log lines arrive),
// so the panel can display all loaded extensions even if they haven't logged yet.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

export interface LogLine {
  ts: number;
  level: "log" | "warn" | "error" | "info";
  msg: string;
}

export interface LogChannel {
  channelId: string;
  name: string;
  lines: LogLine[];
  /** Partial-line buffer for OutputChannel.append(); flushed on newline or appendLine. */
  pending: string;
  unread: number;
}

export interface ExtLogEntry {
  id: string;
  name: string;
  categories: string[];
  channels: Record<string, LogChannel>;
}

type ExtLogsState = Record<string, ExtLogEntry>;

const [_store, _setStore] = createStore<ExtLogsState>({});
export const extLogsStore = _store;

// Selected channel: { extId, channelId } | null
const [selectedChannel, setSelectedChannel] = createSignal<{ extId: string; channelId: string } | null>(null);
export { selectedChannel, setSelectedChannel };

// Show-request: when an extension calls OutputChannel.show(), this fires once so the
// panel can react (focus itself and select the channel).
const [showRequest, _setShowRequest] = createSignal<{ extId: string; channelId: string } | null>(null);
export { showRequest };
export function requestChannelShow(extId: string, channelId: string): void {
  setSelectedChannel({ extId, channelId });
  _setShowRequest({ extId, channelId });
  // Reset to null after one tick so future identical shows still trigger reactivity.
  setTimeout(() => _setShowRequest(null), 0);
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** Called from activation.tsx when a manifest is read — registers the extension and its implicit Console channel. */
export function registerExtension(id: string, name: string, categories: string[]): void {
  if (_store[id]) {
    // Entry may have been pre-created by appendLine() with id as name; upgrade to real metadata.
    _setStore(id, "name", name);
    _setStore(id, "categories", categories);
    return;
  }
  _setStore(id, {
    id,
    name,
    categories,
    channels: {
      console: { channelId: "console", name: "Console", lines: [], pending: "", unread: 0 },
    },
  });
}

/** Called when a named OutputChannel is created by the extension. */
export function addChannel(extId: string, channelId: string, name: string): void {
  const ext = _store[extId];
  if (!ext || ext.channels[channelId]) return;
  _setStore(extId, "channels", channelId, {
    channelId,
    name,
    lines: [],
    pending: "",
    unread: 0,
  });
}

/** Called on __sindri.output.line events. */
export function appendLine(
  extId: string,
  channelId: string,
  level: LogLine["level"],
  msg: string,
  ts: number,
): void {
  // Ensure the extension and channel exist (may arrive before channelCreated in edge cases).
  if (!_store[extId]) {
    _setStore(extId, {
      id: extId,
      name: extId,
      categories: ["Other"],
      channels: {},
    });
  }
  if (!_store[extId].channels[channelId]) {
    _setStore(extId, "channels", channelId, {
      channelId,
      name: channelId === "console" ? "Console" : channelId,
      lines: [],
      pending: "",
      unread: 0,
    });
  }

  const sel = selectedChannel();
  const isSelected = sel?.extId === extId && sel?.channelId === channelId;

  _setStore(
    produce((s) => {
      const ch = s[extId].channels[channelId];
      ch.lines.push({ ts, level, msg });
      if (!isSelected) ch.unread += 1;
    }),
  );
}

/** Clear all lines from a channel. */
export function clearChannel(extId: string, channelId: string): void {
  const ch = _store[extId]?.channels[channelId];
  if (!ch) return;
  _setStore(extId, "channels", channelId, "lines", []);
  _setStore(extId, "channels", channelId, "pending", "");
  _setStore(extId, "channels", channelId, "unread", 0);
}

/** Remove a channel (OutputChannel.dispose). */
export function removeChannel(extId: string, channelId: string): void {
  if (!_store[extId]?.channels[channelId]) return;
  _setStore(
    produce((s) => {
      delete s[extId].channels[channelId];
    }),
  );
}

/** Remove the entire extension entry from the logs panel (called on uninstall). */
export function removeExtensionLogs(extId: string): void {
  if (!_store[extId]) return;
  _setStore(produce((s) => { delete s[extId]; }));
}

/** Reset unread count for a channel (called when the user selects it). */
export function markRead(extId: string, channelId: string): void {
  _setStore(extId, "channels", channelId, "unread", 0);
}

/** Total unread across all channels of an extension. */
export function extUnread(id: string): number {
  const ext = _store[id];
  if (!ext) return 0;
  return Object.values(ext.channels).reduce((acc, ch) => acc + ch.unread, 0);
}

/** Sorted, deduplicated list of categories across all registered extensions. */
export function allCategories(): string[] {
  const cats = new Set<string>();
  for (const ext of Object.values(_store)) {
    for (const c of ext.categories) cats.add(c);
  }
  return [...cats].sort();
}

/** Extensions belonging to a given category (uses categories[0] as primary). */
export function extsInCategory(category: string): ExtLogEntry[] {
  return Object.values(_store).filter((e) => e.categories.includes(category));
}
