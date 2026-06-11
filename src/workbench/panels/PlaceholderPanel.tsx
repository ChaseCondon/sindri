import type { Component } from "solid-js";

export function makePlaceholder(label: string): Component {
  return () => (
    <div style={{ padding: "20px 16px", color: "var(--text-dim)", "font-size": "13px" }}>
      {label} — coming soon
    </div>
  );
}
