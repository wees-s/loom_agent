import type { CSSProperties } from "react";
import type { NarrationTone } from "@loom/shared";

/* ════════════════════════════════════════════════════════════════════════
 * Design-system primitives — pure (no React/DOM). Centralizes the verbatim-
 * repeated "glass panel" recipe, the recurring radii/spacing/font tiers, and
 * the semantic tone palette. Reuses the existing CSS variables; never bakes in
 * new hardcoded theme colors (good/neutral defer to var(--accent)/var(--line2)).
 * ════════════════════════════════════════════════════════════════════════ */

/** Corner radii (px). */
export const RADIUS = { sm: 9, md: 12, lg: 15 } as const;
/** Spacing scale (px). */
export const SPACE = { xs: 4, sm: 8, md: 13, lg: 16 } as const;
/** Font-size tiers (px). */
export const FONT = { xs: 10.5, sm: 11.5, md: 12.5, lg: 13 } as const;

/** Semantic tone → color. good/neutral reuse theme tokens; warn/bad are the
 *  oklch literals already used across the UI. */
export const TONE: Record<NarrationTone, string> = {
  neutral: "var(--line2)",
  good: "var(--accent)",
  warn: "oklch(0.78 0.13 80)",
  bad: "oklch(0.62 0.18 25)",
};

/** Canonical 22px "glass panel" surface (the verbatim-repeated recipe). Merge
 *  overrides on top without restating the recipe (overrides win). */
export function glassPanel(overrides?: CSSProperties): CSSProperties {
  return {
    background: "var(--glass)",
    backdropFilter: "blur(22px) saturate(1.4)",
    WebkitBackdropFilter: "blur(22px) saturate(1.4)",
    border: "1px solid var(--glass-border)",
    boxShadow:
      "0 10px 40px -16px rgba(30,55,45,0.18),inset 0 1px 0 rgba(255,255,255,0.7)",
    borderRadius: RADIUS.lg,
    ...overrides,
  };
}
