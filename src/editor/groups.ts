import { createStore, produce } from "solid-js/store";
import { createSignal } from "solid-js";
import { EditorView } from "@codemirror/view";
import {
  occKey,
  editorStates,
  scrollTops,
  createBuffer,
  removeBuffer,
  freshBufferId,
  buildEditorState,
  registry,
} from "./buffers";

export type GroupId = string;

export interface EditorGroup {
  id: GroupId;
  bufferIds: string[];
  activeBufferId: string;
}

export type LeafNode = { kind: "leaf"; group: GroupId };
export type SplitSplitNode = {
  kind: "split";
  id: string;
  dir: "row" | "column";
  children: SplitNode[];
  sizes: number[];
};
export type SplitNode = LeafNode | SplitSplitNode;

interface GroupStoreState {
  root: SplitNode;
  groups: Record<GroupId, EditorGroup>;
  activeGroup: GroupId;
}

let _gCounter = 0;
function freshGroupId(): GroupId { return `g${++_gCounter}`; }

let _sCounter = 0;
function freshSplitId(): string { return `s${++_sCounter}`; }

const initialGroupId = freshGroupId(); // "g1"

const [groupStore, setGroupStore] = createStore<GroupStoreState>({
  root: { kind: "leaf", group: initialGroupId },
  groups: {
    [initialGroupId]: { id: initialGroupId, bufferIds: [], activeBufferId: "" },
  },
  activeGroup: initialGroupId,
});

export { groupStore };

// ---------------------------------------------------------------------------
// EditorViews — plain Map; imperative engine, never Solid-proxied (ADR-0018 §2)
// ---------------------------------------------------------------------------

const _editorViews = new Map<GroupId, EditorView>();

export function registerEditorView(groupId: GroupId, view: EditorView): void {
  _editorViews.set(groupId, view);
}

export function unregisterEditorView(groupId: GroupId): void {
  _editorViews.delete(groupId);
}

export function getActiveEditorView(): EditorView | undefined {
  return _editorViews.get(groupStore.activeGroup);
}

export function getAllEditorViews(): EditorView[] {
  return Array.from(_editorViews.values());
}

// ---------------------------------------------------------------------------
// Drag state — shared signal so all leaves can show/hide the drop overlay
// ---------------------------------------------------------------------------

export const [dragState, setDragState] = createSignal<{
  bufferId: string;
  fromGroupId: GroupId;
} | null>(null);

// ---------------------------------------------------------------------------
// Tab drag ghost — imperative DOM; never goes through Solid reactivity so
// pointer-move updates are O(1) with no reactive overhead.
// ---------------------------------------------------------------------------

let _ghostEl: HTMLElement | null = null;
/** X offset from the left edge of the dragged tab to where the user grabbed it. */
export let dragGrabOffsetX = 0;
/** Pixel width of the tab being dragged (used to size the placeholder). */
export let dragTabWidth = 0;

export function startDragGhost(
  name: string,
  dirty: boolean,
  width: number,
  x: number,
  y: number,
  grabOffsetX: number,
): void {
  dragGrabOffsetX = grabOffsetX;
  dragTabWidth = width;
  _ghostEl?.remove();
  _ghostEl = document.createElement("div");
  _ghostEl.className = "editor-tab active tab-ghost";
  _ghostEl.style.cssText = `position:fixed;width:${width}px;left:${x}px;top:${y}px;z-index:1000;pointer-events:none;`;
  const span = document.createElement("span");
  span.className = "editor-tab-name";
  span.textContent = name;
  if (dirty) {
    const dot = document.createElement("span");
    dot.className = "editor-tab-dirty";
    dot.textContent = "•";
    span.appendChild(dot);
  }
  _ghostEl.appendChild(span);
  document.body.appendChild(_ghostEl);
  document.body.classList.add("user-dragging");
}

export function updateDragGhostPos(x: number, y?: number): void {
  if (!_ghostEl) return;
  _ghostEl.style.left = `${x}px`;
  if (y !== undefined) _ghostEl.style.top = `${y}px`;
}

/** End a drag: destroy ghost + clear drag signal. Call this instead of setDragState(null). */
export function endDrag(): void {
  _ghostEl?.remove();
  _ghostEl = null;
  document.body.classList.remove("user-dragging");
  setDragState(null);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function setActiveGroup(groupId: GroupId): void {
  if (groupStore.activeGroup !== groupId) setGroupStore("activeGroup", groupId);
}

export function activateBufferInGroup(bufferId: string, groupId: GroupId): void {
  setGroupStore("groups", groupId, "activeBufferId", bufferId);
  setActiveGroup(groupId);
}

/** Open (or re-activate) a buffer in a group. Creates buffer+occurrence state if new.
 *  viewType defaults to "text"; custom editors skip EditorState creation (ADR-0028). */
export function openBufferInGroup(
  bufferId: string,
  groupId: GroupId,
  doc: string,
  name: string,
  path: string | null,
  viewType = "text",
): void {
  if (!registry.buffers[bufferId]) {
    createBuffer(bufferId, path, name, doc, viewType);
  }
  const ok = occKey(groupId, bufferId);
  if (viewType === "text" && !editorStates.has(ok)) {
    editorStates.set(ok, buildEditorState(bufferId, doc, name));
  }
  // Single produce() ensures bufferIds + activeBufferId update atomically —
  // prevents EditorGroup's onMount (triggered by the Show becoming true) from
  // firing before activeBufferId is set and finding no state to create its view.
  setGroupStore(
    produce((s) => {
      const g = s.groups[groupId];
      if (!g) return;
      if (!g.bufferIds.includes(bufferId)) g.bufferIds.push(bufferId);
      g.activeBufferId = bufferId;
    }),
  );
  setActiveGroup(groupId);
}

/** Open a file by path; re-activate if already open in any group (move-not-copy). */
export function openOrActivatePathInActiveGroup(
  path: string,
  name: string,
  contents: string,
): void {
  const existing = Object.values(registry.buffers).find((b) => b.path === path);
  if (existing) {
    for (const [gid, group] of Object.entries(groupStore.groups)) {
      if (group.bufferIds.includes(existing.id)) {
        activateBufferInGroup(existing.id, gid as GroupId);
        return;
      }
    }
  }
  openBufferInGroup(path, groupStore.activeGroup, contents, name, path);
}

/** Open a custom editor for a file; re-activates any existing occurrence (ADR-0028). */
export function openCustomEditorInActiveGroup(
  path: string,
  name: string,
  viewType: string,
): void {
  // Re-activate if already open with the same viewType (dedup by path+viewType, ADR-0028 §7).
  const existing = Object.values(registry.buffers).find(
    (b) => b.path === path && b.viewType === viewType,
  );
  if (existing) {
    for (const [gid, group] of Object.entries(groupStore.groups)) {
      if (group.bufferIds.includes(existing.id)) {
        activateBufferInGroup(existing.id, gid as GroupId);
        return;
      }
    }
  }
  // Stable bufferId keyed by path+viewType so re-opens after close keep the same id.
  const bufferId = `${viewType}:${path}`;
  openBufferInGroup(bufferId, groupStore.activeGroup, "", name, path, viewType);
}

/** Open a loose (unsaved) buffer in the active group. */
export function openLooseInActiveGroup(name: string, contents: string): void {
  const id = freshBufferId();
  openBufferInGroup(id, groupStore.activeGroup, contents, name, null);
}

export function closeBufferInGroup(bufferId: string, groupId: GroupId): void {
  const group = groupStore.groups[groupId];
  if (!group) return;

  const buf = registry.buffers[bufferId];
  if (buf?.dirty && !window.confirm(`Close "${buf.name}" without saving?`)) return;

  // Clean up occurrence-keyed engine state
  const ok = occKey(groupId, bufferId);
  editorStates.delete(ok);
  scrollTops.delete(ok);

  removeBuffer(bufferId);

  const remaining = group.bufferIds.filter((id) => id !== bufferId);

  if (remaining.length === 0) {
    if (Object.keys(groupStore.groups).length === 1) {
      // Last tab in the only group — clear it; welcome screen takes over
      setGroupStore("groups", groupId, { bufferIds: [], activeBufferId: "" });
    } else {
      _removeLeafFromTree(groupId);
    }
  } else {
    const oldIdx = group.bufferIds.indexOf(bufferId);
    const nextActive =
      bufferId === group.activeBufferId
        ? (remaining[oldIdx] ?? remaining[oldIdx - 1] ?? remaining[remaining.length - 1])
        : group.activeBufferId;
    setGroupStore("groups", groupId, { bufferIds: remaining, activeBufferId: nextActive });
  }
}

/** Split the active buffer out of groupId into a new sibling pane.
 *  No-op if the group has fewer than 2 tabs (move-not-copy: nothing to move). */
export function splitGroup(groupId: GroupId, dir: "row" | "column"): void {
  const group = groupStore.groups[groupId];
  if (!group || group.bufferIds.length < 2) return;

  const bufferId = group.activeBufferId;
  if (!bufferId) return;

  const newGroupId = freshGroupId();
  const newSplitId = freshSplitId();

  setGroupStore(
    produce((s) => {
      // Move occurrence data to the new group (text buffers only — ADR-0028)
      const oldOk = occKey(groupId, bufferId);
      const newOk = occKey(newGroupId, bufferId);
      if (registry.buffers[bufferId]?.viewType !== "text") {
        // Custom editor: no EditorState to move; WebviewEditorHost will re-resolve
      } else {
        const state = editorStates.get(oldOk);
        const scroll = scrollTops.get(oldOk);
        if (state) { editorStates.set(newOk, state); editorStates.delete(oldOk); }
        if (scroll !== undefined) { scrollTops.set(newOk, scroll); scrollTops.delete(oldOk); }
      }

      // Update source group
      s.groups[groupId].bufferIds = s.groups[groupId].bufferIds.filter((id) => id !== bufferId);
      const remaining = s.groups[groupId].bufferIds;
      s.groups[groupId].activeBufferId = remaining[remaining.length - 1] ?? "";

      // Create target group
      s.groups[newGroupId] = { id: newGroupId, bufferIds: [bufferId], activeBufferId: bufferId };

      // Replace leaf in tree
      s.root = _replaceLeafWithSplit(s.root, groupId, newGroupId, dir, newSplitId);
      s.activeGroup = newGroupId;
    }),
  );
}

/** Move a tab from one group to another (DnD center-drop). */
export function moveBufferToGroup(bufferId: string, fromGroupId: GroupId, toGroupId: GroupId): void {
  if (fromGroupId === toGroupId) return;

  setGroupStore(
    produce((s) => {
      const from = s.groups[fromGroupId];
      const to = s.groups[toGroupId];
      if (!from || !to) return;

      const fromOk = occKey(fromGroupId, bufferId);
      const toOk = occKey(toGroupId, bufferId);
      if (registry.buffers[bufferId]?.viewType !== "text") {
        // Custom editor: no EditorState to move; WebviewEditorHost will re-resolve
      } else {
        const state = editorStates.get(fromOk);
        const scroll = scrollTops.get(fromOk);
        if (state) { editorStates.set(toOk, state); editorStates.delete(fromOk); }
        if (scroll !== undefined) { scrollTops.set(toOk, scroll); scrollTops.delete(fromOk); }
      }

      from.bufferIds = from.bufferIds.filter((id) => id !== bufferId);
      from.activeBufferId = from.bufferIds[from.bufferIds.length - 1] ?? "";

      if (!to.bufferIds.includes(bufferId)) to.bufferIds.push(bufferId);
      to.activeBufferId = bufferId;
      s.activeGroup = toGroupId;
    }),
  );

  // Collapse the source if it's now empty (and not the only group)
  const src = groupStore.groups[fromGroupId];
  if (src && src.bufferIds.length === 0 && Object.keys(groupStore.groups).length > 1) {
    _removeLeafFromTree(fromGroupId);
  }
}

/** Split targetGroupId and place bufferId (from fromGroupId) in the new sibling. */
export function splitGroupWithBuffer(
  targetGroupId: GroupId,
  dir: "row" | "column",
  bufferId: string,
  fromGroupId: GroupId,
): void {
  const newGroupId = freshGroupId();
  const newSplitId = freshSplitId();

  setGroupStore(
    produce((s) => {
      const from = s.groups[fromGroupId];
      if (!from) return;

      const fromOk = occKey(fromGroupId, bufferId);
      const toOk = occKey(newGroupId, bufferId);
      if (registry.buffers[bufferId]?.viewType !== "text") {
        // Custom editor: no EditorState to move; WebviewEditorHost will re-resolve
      } else {
        const state = editorStates.get(fromOk);
        const scroll = scrollTops.get(fromOk);
        if (state) { editorStates.set(toOk, state); editorStates.delete(fromOk); }
        if (scroll !== undefined) { scrollTops.set(toOk, scroll); scrollTops.delete(fromOk); }
      }

      from.bufferIds = from.bufferIds.filter((id) => id !== bufferId);
      from.activeBufferId = from.bufferIds[from.bufferIds.length - 1] ?? "";

      s.groups[newGroupId] = { id: newGroupId, bufferIds: [bufferId], activeBufferId: bufferId };
      s.root = _insertSplitNextTo(s.root, targetGroupId, newGroupId, dir, newSplitId);
      s.activeGroup = newGroupId;
    }),
  );

  // Collapse the source if empty
  if (fromGroupId !== targetGroupId) {
    const src = groupStore.groups[fromGroupId];
    if (src && src.bufferIds.length === 0 && Object.keys(groupStore.groups).length > 1) {
      _removeLeafFromTree(fromGroupId);
    }
  }
}

/** Update the sizes array for a split node identified by its id. */
export function setSplitSizes(splitId: string, sizes: number[]): void {
  setGroupStore(produce((s) => { _mutateSplitSizes(s.root, splitId, sizes); }));
}

/** Reorder a buffer within its group's tab list.
 *  newIndex is the insertion position in the "without this tab" array. */
export function reorderBufferInGroup(bufferId: string, groupId: GroupId, newIndex: number): void {
  setGroupStore("groups", groupId, "bufferIds", (ids) => {
    const without = ids.filter((id) => id !== bufferId);
    const clipped = Math.max(0, Math.min(newIndex, without.length));
    return [...without.slice(0, clipped), bufferId, ...without.slice(clipped)];
  });
}

/** Close an entire group pane (all tabs + leaf).
 *  If it's the only group, seeds a fresh untitled instead of collapsing. */
export function closePaneGroup(groupId: GroupId): void {
  const group = groupStore.groups[groupId];
  if (!group) return;

  const dirtyNames = group.bufferIds
    .map((id) => registry.buffers[id])
    .filter((b) => b?.dirty)
    .map((b) => b!.name);

  if (dirtyNames.length > 0) {
    if (!window.confirm(`Close without saving?\n${dirtyNames.join(", ")}`)) return;
  }

  // Clean up all occurrence-keyed engine state and buffer registry entries
  for (const bufferId of [...group.bufferIds]) {
    editorStates.delete(occKey(groupId, bufferId));
    scrollTops.delete(occKey(groupId, bufferId));
    removeBuffer(bufferId);
  }

  const groupCount = Object.keys(groupStore.groups).length;

  if (groupCount === 1) {
    // Last group — clear it; welcome screen takes over
    setGroupStore("groups", groupId, { bufferIds: [], activeBufferId: "" });
  } else {
    _removeLeafFromTree(groupId);
  }
}

// ---------------------------------------------------------------------------
// Private tree helpers (operate on mutable produce-draft, never call setGroupStore)
// ---------------------------------------------------------------------------

function _removeLeafFromTree(groupId: GroupId): void {
  setGroupStore(
    produce((s) => {
      const newRoot = _pruneLeaf(s.root, groupId);
      if (newRoot) s.root = newRoot;
      delete s.groups[groupId];
      if (s.activeGroup === groupId) {
        const keys = Object.keys(s.groups);
        if (keys.length > 0) s.activeGroup = keys[0];
      }
    }),
  );
}

/** Returns null if the node was removed, or the (possibly collapsed) replacement. */
function _pruneLeaf(node: SplitNode, groupId: GroupId): SplitNode | null {
  if (node.kind === "leaf") return node.group === groupId ? null : node;
  const newChildren: SplitNode[] = [];
  for (const child of node.children) {
    const r = _pruneLeaf(child, groupId);
    if (r !== null) newChildren.push(r);
  }
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0]; // collapse single-child split
  return { ...node, children: newChildren };
}

function _replaceLeafWithSplit(
  node: SplitNode,
  groupId: GroupId,
  newGroupId: GroupId,
  dir: "row" | "column",
  splitId: string,
): SplitNode {
  if (node.kind === "leaf") {
    if (node.group !== groupId) return node;
    return {
      kind: "split",
      id: splitId,
      dir,
      children: [{ kind: "leaf", group: groupId }, { kind: "leaf", group: newGroupId }],
      sizes: [50, 50],
    };
  }
  return { ...node, children: node.children.map((c) => _replaceLeafWithSplit(c, groupId, newGroupId, dir, splitId)) };
}

function _insertSplitNextTo(
  node: SplitNode,
  targetGroupId: GroupId,
  newGroupId: GroupId,
  dir: "row" | "column",
  splitId: string,
): SplitNode {
  if (node.kind === "leaf") {
    if (node.group !== targetGroupId) return node;
    return {
      kind: "split",
      id: splitId,
      dir,
      children: [{ kind: "leaf", group: targetGroupId }, { kind: "leaf", group: newGroupId }],
      sizes: [50, 50],
    };
  }
  return { ...node, children: node.children.map((c) => _insertSplitNextTo(c, targetGroupId, newGroupId, dir, splitId)) };
}

function _mutateSplitSizes(node: SplitNode, splitId: string, sizes: number[]): void {
  if (node.kind === "leaf") return;
  if (node.id === splitId) { node.sizes = sizes; return; }
  for (const child of node.children) _mutateSplitSizes(child, splitId, sizes);
}
