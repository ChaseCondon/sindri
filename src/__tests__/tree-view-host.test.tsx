// Chrome render smoke test — TreeViewHost (sindri.ui tree-view binding surface).
//
// Verifies that the TreeViewHost component mounts without crashing when the
// exthost client returns an empty list. This is the main workbench-chrome
// render proof for C6 / B7 in the phase-1 review.

import { vi, describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue("[]"),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// Override the host module so TreeViewHost uses the mock client, not the
// real singleton (which is initialised once at module load).
vi.mock("../extensions/host", () => ({
  getExtHostClient: () => ({
    dispatch: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn().mockResolvedValue(() => {}),
    activate: vi.fn().mockResolvedValue(undefined),
    activateSinxt: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue(""),
    treeViewGetChildren: vi.fn().mockResolvedValue("[]"),
    quickPickResult: vi.fn().mockResolvedValue(undefined),
    webviewPanelMessage: vi.fn().mockResolvedValue(undefined),
    editorReadResult: vi.fn().mockResolvedValue(undefined),
    provideDecorations: vi.fn().mockResolvedValue("[]"),
  }),
}));

import { TreeViewHost } from "../workbench/panels/TreeViewHost";

describe("TreeViewHost — workbench chrome render", () => {
  afterEach(() => cleanup());

  it("mounts without crashing (empty tree)", () => {
    const { container } = render(() => <TreeViewHost treeId="test.treeview" />);
    expect(container).toBeTruthy();
    expect(container.firstChild).not.toBeNull();
  });

  it("renders 'No items' once async resource resolves with empty list", async () => {
    const { findByText } = render(() => <TreeViewHost treeId="test.treeview" />);
    // findByText polls until the element appears or the test times out.
    const el = await findByText("No items");
    expect(el).toBeTruthy();
  });
});
