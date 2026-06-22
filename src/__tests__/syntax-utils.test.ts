// Unit tests for the tree-sitter CM6 byte↔char conversion utilities.
//
// posToByteOffset, byteOffsetToPos, byteCol are the only pure, testable logic
// in the syntax bridge that is also genuinely bug-prone (multibyte chars).
// They must be correct for incremental edit deltas sent to the Rust worker.

import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import { posToByteOffset, byteOffsetToPos, byteCol } from "../editor/syntax";

// ── helpers ───────────────────────────────────────────────────────────────────

function doc(s: string) {
  return Text.of(s.split("\n"));
}

// ── posToByteOffset ───────────────────────────────────────────────────────────

describe("posToByteOffset", () => {
  it("returns char position for pure ASCII", () => {
    const d = doc("fn main() {}");
    expect(posToByteOffset(d, 0)).toBe(0);
    expect(posToByteOffset(d, 3)).toBe(3);
    expect(posToByteOffset(d, 12)).toBe(12);
  });

  it("accounts for 2-byte UTF-8 sequences", () => {
    // 'é' = U+00E9, encodes as 2 bytes; char offset 1 → byte offset 2
    const d = doc("éx");
    expect(posToByteOffset(d, 0)).toBe(0);
    expect(posToByteOffset(d, 1)).toBe(2);  // after 'é'
    expect(posToByteOffset(d, 2)).toBe(3);  // after 'x'
  });

  it("accounts for 3-byte CJK characters", () => {
    // '中' = U+4E2D, encodes as 3 bytes
    const d = doc("中x");
    expect(posToByteOffset(d, 0)).toBe(0);
    expect(posToByteOffset(d, 1)).toBe(3);  // after '中'
    expect(posToByteOffset(d, 2)).toBe(4);  // after 'x'
  });

  it("accounts for 4-byte emoji (surrogate pair in JS)", () => {
    // '😀' = U+1F600, encodes as 4 bytes UTF-8; occupies 2 CM6 char units
    const d = doc("😀x");
    expect(posToByteOffset(d, 0)).toBe(0);
    expect(posToByteOffset(d, 2)).toBe(4);  // after 😀 (2 CM6 units = 4 UTF-8 bytes)
    expect(posToByteOffset(d, 3)).toBe(5);  // after 'x'
  });

  it("handles mid-string multibyte chars", () => {
    const d = doc("a中b");
    expect(posToByteOffset(d, 1)).toBe(1);  // after 'a'
    expect(posToByteOffset(d, 2)).toBe(4);  // after '中' (3 bytes)
    expect(posToByteOffset(d, 3)).toBe(5);  // after 'b'
  });
});

// ── byteOffsetToPos ───────────────────────────────────────────────────────────

describe("byteOffsetToPos", () => {
  it("is the inverse of posToByteOffset for ASCII", () => {
    const d = doc("let x = 42;");
    for (let i = 0; i <= d.length; i++) {
      expect(byteOffsetToPos(d, posToByteOffset(d, i))).toBe(i);
    }
  });

  it("is the inverse of posToByteOffset for multibyte", () => {
    const d = doc("a中😀b");
    const positions = [0, 1, 2, 4, 5]; // CM6 char positions
    for (const pos of positions) {
      const byte = posToByteOffset(d, pos);
      expect(byteOffsetToPos(d, byte)).toBe(pos);
    }
  });
});

// ── byteCol ───────────────────────────────────────────────────────────────────

describe("byteCol", () => {
  it("returns 0 for column at line start", () => {
    const d = doc("fn main()");
    const line = d.lineAt(0);
    expect(byteCol(d, line.from, line.from)).toBe(0);
  });

  it("returns byte count for ASCII columns", () => {
    const d = doc("fn main()");
    const line = d.lineAt(0);
    // 'f' 'n' ' ' = 3 bytes, char offset 3
    expect(byteCol(d, line.from, line.from + 3)).toBe(3);
  });

  it("returns byte count for a CJK column", () => {
    // Line: "中文" — '中' = 3 bytes, so column after '中' is 3
    const d = doc("中文");
    const line = d.lineAt(0);
    expect(byteCol(d, line.from, line.from + 1)).toBe(3);
    expect(byteCol(d, line.from, line.from + 2)).toBe(6);
  });
});

// ── _doEdit delta derivation (multi-line insert) ──────────────────────────────

describe("edit delta newEndRow/newEndCol derivation", () => {
  // Verify the formula used inside _doEdit for multi-line inserts.
  // This mirrors the logic in syntax.ts _doEdit without invoking Tauri IPC.
  const enc = new TextEncoder();

  function deriveNewEnd(
    syncedDoc: ReturnType<typeof doc>,
    fromCharPos: number,
    insertedStr: string,
  ): { newEndRow: number; newEndCol: number } {
    const startLine = syncedDoc.lineAt(fromCharPos);
    const insertedLines = insertedStr.split("\n");
    const newEndRow = (startLine.number - 1) + insertedLines.length - 1;
    const lastInserted = insertedLines[insertedLines.length - 1];
    const startColBytes = enc.encode(
      syncedDoc.sliceString(startLine.from, fromCharPos)
    ).length;
    const newEndCol =
      insertedLines.length === 1
        ? startColBytes + enc.encode(lastInserted).length
        : enc.encode(lastInserted).length;
    return { newEndRow, newEndCol };
  }

  it("single-line insert at col 0", () => {
    const d = doc("fn f() {}");
    const { newEndRow, newEndCol } = deriveNewEnd(d, 0, "let x = 1; ");
    expect(newEndRow).toBe(0);
    expect(newEndCol).toBe("let x = 1; ".length);
  });

  it("multi-line insert increments row and resets col", () => {
    const d = doc("fn f() {}");
    const inserted = "let x = 1;\nlet y = 2;\n";
    const { newEndRow, newEndCol } = deriveNewEnd(d, 0, inserted);
    // 3 lines in inserted → row increases by 2; last line is empty → col 0
    expect(newEndRow).toBe(2);
    expect(newEndCol).toBe(0);
  });

  it("multi-line insert with non-empty last line", () => {
    const d = doc("fn f() {}");
    const inserted = "let x = 1;\nreturn x;";
    const { newEndRow, newEndCol } = deriveNewEnd(d, 0, inserted);
    expect(newEndRow).toBe(1);
    expect(newEndCol).toBe("return x;".length);
  });

  it("insert at non-zero col adds col bytes to new end", () => {
    const d = doc("fn f() {}");
    // Insert at position 3 ("f" after "fn ")
    const inserted = "oo";
    const { newEndRow, newEndCol } = deriveNewEnd(d, 3, inserted);
    expect(newEndRow).toBe(0);
    expect(newEndCol).toBe(3 + 2); // 3 existing col bytes + 2 from "oo"
  });
});
