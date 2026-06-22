// Smoke tests for the sindri.ui.showQuickPick binding surface store.
//
// The quick-pick store is the frontend side of the extension-host quick-pick
// op (op_ui_show_quick_pick in runtime.rs). Activation emits
// __sindri.ui.quickPickShow → frontend calls openQuickPick() → component
// renders. These tests verify that the signal plumbing holds.

import { describe, it, expect, beforeEach } from "vitest";
import {
  openQuickPick,
  closeQuickPick,
  updateQuickPickItems,
  quickPickSession,
  type QuickPickSession,
} from "../quick-pick/store";

function session(overrides?: Partial<QuickPickSession>): QuickPickSession {
  return {
    requestId: "r-default",
    items: [],
    placeholder: null,
    title: null,
    streaming: false,
    ...overrides,
  };
}

describe("quick-pick store — sindri.ui.showQuickPick binding surface", () => {
  beforeEach(() => {
    // Reset to clean state between tests.
    closeQuickPick(quickPickSession.active?.requestId ?? "");
  });

  it("openQuickPick sets the active session", () => {
    openQuickPick(session({ requestId: "r1", items: [{ label: "Alpha" }] }));
    expect(quickPickSession.active?.requestId).toBe("r1");
    expect(quickPickSession.active?.items).toHaveLength(1);
    expect(quickPickSession.active?.items[0].label).toBe("Alpha");
  });

  it("closeQuickPick clears the active session", () => {
    openQuickPick(session({ requestId: "r2" }));
    closeQuickPick("r2");
    expect(quickPickSession.active).toBeNull();
  });

  it("closeQuickPick ignores a mismatched requestId", () => {
    openQuickPick(session({ requestId: "r3" }));
    closeQuickPick("wrong-id");
    expect(quickPickSession.active?.requestId).toBe("r3");
  });

  it("updateQuickPickItems replaces items for the matching session (streaming)", () => {
    openQuickPick(session({ requestId: "r4", streaming: true }));
    updateQuickPickItems("r4", [{ label: "A" }, { label: "B" }, { label: "C" }]);
    expect(quickPickSession.active?.items).toHaveLength(3);
    expect(quickPickSession.active?.items[2].label).toBe("C");
  });

  it("updateQuickPickItems is ignored for a mismatched requestId", () => {
    openQuickPick(session({ requestId: "r5", items: [{ label: "Original" }] }));
    updateQuickPickItems("wrong-id", [{ label: "Replacement" }]);
    expect(quickPickSession.active?.items[0].label).toBe("Original");
  });

  it("placeholder and title are preserved on open", () => {
    openQuickPick(session({ requestId: "r6", placeholder: "Choose one", title: "My Pick" }));
    expect(quickPickSession.active?.placeholder).toBe("Choose one");
    expect(quickPickSession.active?.title).toBe("My Pick");
  });
});
