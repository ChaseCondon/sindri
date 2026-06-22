import { onMount, onCleanup, createEffect, untrack } from "solid-js";
import { EditorView } from "@codemirror/view";
import {
  groupStore,
  registerEditorView,
  unregisterEditorView,
  setActiveGroup,
  type GroupId,
} from "./groups";
import { occKey, editorStates, scrollTops, registry } from "./buffers";
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
    if (!activeId) return;
    // If the initial active buffer is a custom editor, defer CM view creation.
    if ((registry.buffers[activeId]?.viewType ?? "text") !== "text") {
      prevBufferId = activeId;
      return;
    }
    const state = editorStates.get(occKey(props.groupId, activeId));
    if (!state) return;
    view = new EditorView({ state, parent });
    registerEditorView(props.groupId, view);
    prevBufferId = activeId;
  });

  createEffect(() => {
    const group = groupStore.groups[props.groupId];
    if (!group) return;
    const nextId = group.activeBufferId;
    if (!nextId || nextId === prevBufferId) return;

    const nextBuf = registry.buffers[nextId];
    const nextIsText = !nextBuf || nextBuf.viewType === "text";

    // Stash outgoing text tab before switching to anything.
    if (view && prevBufferId) {
      const prevBuf = registry.buffers[prevBufferId];
      if (!prevBuf || prevBuf.viewType === "text") {
        editorStates.set(occKey(props.groupId, prevBufferId), view.state);
        scrollTops.set(occKey(props.groupId, prevBufferId), view.scrollDOM.scrollTop);
      }
    }

    prevBufferId = nextId;

    // Going to a custom editor — CM view has nothing to do.
    if (!nextIsText) return;

    const nextState = editorStates.get(occKey(props.groupId, nextId));
    if (!nextState) return;

    if (!view) {
      // Lazy-create the CM view on first text activation.
      view = new EditorView({ state: nextState, parent });
      registerEditorView(props.groupId, view);
      return;
    }

    view.setState(nextState);
    // Re-apply current theme in case it changed while this state was stashed.
    view.dispatch({ effects: themeCompartment.reconfigure(getCurrentCM6Extension()) });
    const savedScroll = scrollTops.get(occKey(props.groupId, nextId)) ?? 0;
    view.requestMeasure({
      read: () => savedScroll,
      write: (s) => { view!.scrollDOM.scrollTop = s; },
    });
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
