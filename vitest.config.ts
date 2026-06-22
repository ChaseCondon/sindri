import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "happy-dom",
    globals: true,
    // SolidJS JSX must be transformed as web (browser) code, not Node.
    transformMode: { web: [/\.[jt]sx$/] },
    // Suppress the createRoot-outside-root warning that fires in test env.
    onConsoleLog: (msg) =>
      msg.includes("computations created outside") ? false : undefined,
  },
});
