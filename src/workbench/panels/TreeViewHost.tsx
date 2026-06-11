import { createResource, createSignal, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { getExtHostClient } from "../../extensions/host";
import type { ExtHostClient } from "../../extensions/host";

interface TreeItem {
  id: string;
  label: string;
  description?: string;
  /** 0 = None, 1 = Collapsed, 2 = Expanded */
  collapsibleState?: number;
}

async function fetchChildren(
  client: ExtHostClient,
  treeId: string,
  elementId: string | undefined,
): Promise<TreeItem[]> {
  try {
    const json = await client.treeViewGetChildren(treeId, elementId);
    if (!json) return [];
    return JSON.parse(json) as TreeItem[];
  } catch {
    return [];
  }
}

function TreeNode(props: {
  treeId: string;
  item: TreeItem;
  depth: number;
  expanded: Accessor<Record<string, boolean>>;
  toggle: (id: string) => void;
  client: ExtHostClient;
}) {
  const isCollapsible = () => (props.item.collapsibleState ?? 0) > 0;
  const isOpen = () => !!props.expanded()[props.item.id];

  const [children] = createResource(
    () => (isCollapsible() && isOpen() ? props.item.id : null),
    (elemId) => fetchChildren(props.client, props.treeId, elemId),
  );

  return (
    <>
      <div
        class="tree-node"
        style={{
          display: "flex",
          "align-items": "center",
          padding: "2px 0",
          "padding-left": `${8 + props.depth * 16}px`,
          cursor: isCollapsible() ? "pointer" : "default",
          "font-size": "13px",
          "user-select": "none",
        }}
        onClick={() => isCollapsible() && props.toggle(props.item.id)}
      >
        <span
          style={{
            display: "inline-block",
            width: "14px",
            "text-align": "center",
            "font-size": "10px",
            "flex-shrink": "0",
            color: "var(--text-dim)",
          }}
        >
          {isCollapsible() ? (isOpen() ? "▾" : "▸") : ""}
        </span>
        <span style={{ "margin-left": "4px" }}>{props.item.label}</span>
        <Show when={props.item.description}>
          <span
            style={{
              "margin-left": "8px",
              color: "var(--text-dim)",
              "font-size": "12px",
            }}
          >
            {props.item.description}
          </span>
        </Show>
      </div>
      <Show when={isOpen()}>
        <For each={children() ?? []}>
          {(child) => (
            <TreeNode
              treeId={props.treeId}
              item={child}
              depth={props.depth + 1}
              expanded={props.expanded}
              toggle={props.toggle}
              client={props.client}
            />
          )}
        </For>
      </Show>
    </>
  );
}

export function TreeViewHost(props: { treeId: string }) {
  const client = getExtHostClient();
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const [rootItems] = createResource(
    () => props.treeId,
    (id) => fetchChildren(client, id, undefined),
  );

  return (
    <div style={{ overflow: "auto", height: "100%", "padding-top": "4px" }}>
      <Show when={rootItems.loading}>
        <div style={{ padding: "8px 16px", color: "var(--text-dim)", "font-size": "13px" }}>
          Loading…
        </div>
      </Show>
      <Show when={!rootItems.loading && rootItems()?.length === 0}>
        <div style={{ padding: "8px 16px", color: "var(--text-dim)", "font-size": "13px" }}>
          No items
        </div>
      </Show>
      <For each={rootItems() ?? []}>
        {(item) => (
          <TreeNode
            treeId={props.treeId}
            item={item}
            depth={0}
            expanded={expanded}
            toggle={toggle}
            client={client}
          />
        )}
      </For>
    </div>
  );
}
