// Smoke tests for the sindri.ui ExtHostClient binding surface (ADR-0026 Tier 1).
//
// In a non-Tauri (test / browser) context isTauri() returns false and
// getExtHostClient() returns BrowserExtHostClient — the no-op shim that
// satisfies the full ExtHostClient interface without any native IPC.
// These tests verify that contract so regressions are caught before the
// TauriExtHostClient path is even exercised.

import { vi, describe, it, expect, beforeAll } from "vitest";

// Stub out Tauri API modules before any imports that pull them in.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { getExtHostClient } from "../extensions/host";

// In test env (no __TAURI_INTERNALS__), isTauri() → false → BrowserExtHostClient.

describe("ExtHostClient — browser/no-op implementation", () => {
  let client: ReturnType<typeof getExtHostClient>;

  beforeAll(() => {
    client = getExtHostClient();
  });

  it("dispatch resolves without throwing", async () => {
    await expect(client.dispatch("test.event", "{}")).resolves.toBeUndefined();
  });

  it("listen returns a callable unlisten function", async () => {
    const unlisten = await client.listen("test.event", () => {});
    expect(typeof unlisten).toBe("function");
    expect(() => unlisten()).not.toThrow();
  });

  it("treeViewGetChildren returns '[]'", async () => {
    const result = await client.treeViewGetChildren("test.treeview");
    expect(result).toBe("[]");
  });

  it("quickPickResult resolves", async () => {
    await expect(client.quickPickResult("req-1", null)).resolves.toBeUndefined();
  });

  it("executeCommand returns empty string", async () => {
    const result = await client.executeCommand("test.cmd");
    expect(result).toBe("");
  });

  it("webviewPanelMessage resolves", async () => {
    await expect(client.webviewPanelMessage("panel-1", "{}")).resolves.toBeUndefined();
  });

  it("editorReadResult resolves", async () => {
    await expect(client.editorReadResult("req-2", null)).resolves.toBeUndefined();
  });

  it("provideDecorations returns '[]'", async () => {
    const result = await client.provideDecorations("ext.id", "deco.provider", "{}");
    expect(result).toBe("[]");
  });
});
