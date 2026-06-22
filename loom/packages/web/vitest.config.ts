import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest config for @loom/web.
 *
 * The web tests render real React components into jsdom, so the canvas math
 * (edgePath/getTotalLength/getPointAtLength), RAF-driven tick loop and the
 * ResizeObserver-driven applyFit all run. jsdom does NOT implement those, so
 * `setupTests.ts` polyfills exactly the surface the canvas touches — enough to
 * keep the components from throwing FALSE crashes (an unpolyfilled jsdom would
 * itself blow up and mask the real bug we are hunting).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
