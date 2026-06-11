import { onMount, onCleanup, createEffect, untrack } from "solid-js";
import { EditorView } from "@codemirror/view";
import {
  groupStore,
  registerEditorView,
  unregisterEditorView,
  setActiveGroup,
  type GroupId,
} from "./groups";
import { occKey, editorStates, scrollTops } from "./buffers";
import { themeCompartment, getCurrentCM6Extension } from "../theme/compartment";

interface Props {
  groupId: GroupId;
}

export function EditorGroup(props: Props) {
  let parent!: HTMLDivElement;
  let prevBufferId = "";
  let view: EditorView | undefined;

  onMount(() => {
    const group = untrack(() => groupStore.groups[props.groupId]);
    if (!group) return;
    const activeId = group.activeBufferId;
    const state = editorStates.get(occKey(props.groupId, activeId));
    if (!state) return;
    view = new EditorView({ state, parent });
    registerEditorView(props.groupId, view);
    prevBufferId = activeId;
  });

  // Stash outgoing state + scroll, setState the incoming one. Same logic as
  // ADR-0016 but scoped to this group's occurrence keys.
  createEffect(() => {
    const group = groupStore.groups[props.groupId];
    if (!group) return;
    const nextId = group.activeBufferId;
    if (!view || !nextId || nextId === prevBufferId) return;

    if (prevBufferId) {
      editorStates.set(occKey(props.groupId, prevBufferId), view.state);
      scrollTops.set(occKey(props.groupId, prevBufferId), view.scrollDOM.scrollTop);
    }

    const nextState = editorStates.get(occKey(props.groupId, nextId));
    if (nextState) {
      view.setState(nextState);
      // setState restores the compartment config that was baked into nextState,
      // which may be stale if the theme changed since that state was last snapshotted.
      // Re-apply the current theme to keep every tab in sync.
      view.dispatch({ effects: themeCompartment.reconfigure(getCurrentCM6Extension()) });
      const savedScroll = scrollTops.get(occKey(props.groupId, nextId)) ?? 0;
      view.requestMeasure({
        read: () => savedScroll,
        write: (s) => { view!.scrollDOM.scrollTop = s; },
      });
    }
    prevBufferId = nextId;
  });

  onCleanup(() => {
    view?.destroy();
    view = undefined;
    unregisterEditorView(props.groupId);
  });

  return (
    <div
      class="editor"
      ref={parent}
      onFocusIn={() => setActiveGroup(props.groupId)}
    />
  );
}
