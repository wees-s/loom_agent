# Design System Foundation (slice D v1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Centralize the repeated "glass panel" style, recurring radii/spacing/fonts, and semantic tone colors into a pure `theme/primitives.ts`; add `prefers-reduced-motion` + `:focus-visible` + a shared `--accent` token to `tokens.css`; adopt the primitives in three low-risk surfaces.

**Architecture:** A pure primitives module (no React/DOM) returning `CSSProperties`/constants, reusing existing CSS variables. CSS-level a11y additions. Adoption limited to Storyline/LogStrip/GenerateFlow (small, co-located files whose tests guard against regression). Big files untouched.

**Tech Stack:** TypeScript (strict), React 18 CSSProperties, vitest.

## Global Constraints

- `strict` + `verbatimModuleSyntax`; `import type` for type-only.
- Preserve the 1:1 mockup look — the adopted surfaces must compute the SAME styles (glass recipe is verbatim; radii 15/16 unchanged).
- No hardcoded colors reintroduced: `TONE.good`/`neutral` reuse `var(--accent)`/`var(--line2)`; only `warn`/`bad` keep their oklch literals (already in use).
- No new runtime deps.

---

### Task 1: `theme/primitives.ts` + tokens.css a11y/`--accent`

**Files:**
- Create: `packages/web/src/theme/primitives.ts`
- Modify: `packages/web/src/theme/tokens.css` (add `--accent` to both theme blocks; add reduced-motion + focus-visible rules)
- Test: `packages/web/src/theme/primitives.test.ts`

**Produces:** `glassPanel(overrides?)`, `RADIUS`, `SPACE`, `FONT`, `TONE`.

- [ ] **Step 1: Failing test** — `packages/web/src/theme/primitives.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { glassPanel, RADIUS, SPACE, FONT, TONE } from "./primitives";

describe("glassPanel", () => {
  it("returns the canonical glass recipe", () => {
    const g = glassPanel();
    expect(g.background).toBe("var(--glass)");
    expect(g.backdropFilter).toContain("blur(22px)");
    expect(g.border).toContain("var(--glass-border)");
    expect(typeof g.boxShadow).toBe("string");
    expect(g.borderRadius).toBe(RADIUS.lg);
  });
  it("merges overrides (overrides win)", () => {
    const g = glassPanel({ width: 300, borderRadius: 8 });
    expect(g.width).toBe(300);
    expect(g.borderRadius).toBe(8); // override wins
    expect(g.background).toBe("var(--glass)"); // recipe preserved
  });
});

describe("scales + tones", () => {
  it("RADIUS/SPACE/FONT have the expected anchors", () => {
    expect(RADIUS.lg).toBe(15);
    expect(SPACE.lg).toBe(16);
    expect(FONT.lg).toBe(13);
  });
  it("TONE covers all four tones with non-empty values", () => {
    for (const t of ["neutral", "good", "warn", "bad"] as const) {
      expect(typeof TONE[t]).toBe("string");
      expect(TONE[t].length).toBeGreaterThan(0);
    }
    expect(TONE.good).toBe("var(--accent)");
  });
});
```

- [ ] **Step 2: Run → fail**: `pnpm --filter @loom/web exec vitest run primitives` → FAIL (module missing).

- [ ] **Step 3: Implement `primitives.ts`**:

```ts
import type { CSSProperties } from "react";
import type { NarrationTone } from "@loom/shared";

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
 *  overrides on top without restating the recipe. */
export function glassPanel(overrides?: CSSProperties): CSSProperties {
  return {
    background: "var(--glass)",
    backdropFilter: "blur(22px) saturate(1.4)",
    WebkitBackdropFilter: "blur(22px) saturate(1.4)",
    border: "1px solid var(--glass-border)",
    boxShadow: "0 10px 40px -16px rgba(30,55,45,0.18),inset 0 1px 0 rgba(255,255,255,0.7)",
    borderRadius: RADIUS.lg,
    ...overrides,
  };
}
```

- [ ] **Step 4: Edit `tokens.css`**

Add `--accent: oklch(0.62 0.14 160);` as the last variable inside the `[data-loom] {` block (light, before its closing `}` at line 43) AND inside the `[data-loom][data-theme="dark"] {` block (before its closing `}` at line 66).

Append at the end of the file (after the placeholder rule):
```css
/* Accessibility: honor reduced-motion (decorative blobs/pulses) + keyboard focus. */
@media (prefers-reduced-motion: reduce) {
  [data-loom] *,
  [data-loom] *::before,
  [data-loom] *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
[data-loom] :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}
```

- [ ] **Step 5: Run → pass + typecheck**: `pnpm --filter @loom/web exec vitest run primitives && pnpm --filter @loom/web typecheck` → PASS.

- [ ] **Step 6: Commit**:
```bash
git add packages/web/src/theme/primitives.ts packages/web/src/theme/primitives.test.ts packages/web/src/theme/tokens.css
git commit -m "feat(web): design-system primitives (glassPanel/RADIUS/SPACE/FONT/TONE) + --accent token + reduced-motion/focus-visible a11y"
```

---

### Task 2: Adopt primitives in Storyline, LogStrip, GenerateFlow

**Files:**
- Modify: `packages/web/src/components/Storyline.tsx`
- Modify: `packages/web/src/components/LogStrip.tsx`
- Modify: `packages/web/src/components/GenerateFlow.tsx`

(No new tests — the existing `Storyline.test.tsx` is the regression guard; behavior/computed styles are unchanged.)

- [ ] **Step 1: Storyline.tsx**

Add import: `import { glassPanel, TONE, RADIUS, FONT } from "../theme/primitives";`
Replace the `PANEL_STYLE` constant:
```ts
const PANEL_STYLE: CSSProperties = glassPanel({
  width: 300,
  flex: "none",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
});
```
Delete the local `TONE_DOT` constant and replace its single use `TONE_DOT[line.tone]` with `TONE[line.tone]`. (The `NarrationTone` import for the deleted map can stay if still referenced; otherwise leave the other imports untouched.)

- [ ] **Step 2: LogStrip.tsx**

Add import: `import { glassPanel, SPACE } from "../theme/primitives";`
Replace `STRIP_STYLE`:
```ts
const STRIP_STYLE: CSSProperties = glassPanel({
  display: "flex",
  alignItems: "center",
  gap: SPACE.lg,
  padding: "9px 16px",
});
```
(Same computed result as before: glassPanel supplies background/backdrop/border/boxShadow/borderRadius:15; the override supplies layout.)

- [ ] **Step 3: GenerateFlow.tsx**

Add import: `import { RADIUS, FONT } from "../theme/primitives";`
Use `RADIUS.sm` for the textarea + button `borderRadius` (currently `9`), and `FONT.md` for the button `fontSize` (currently `12.5`). Purely a constants swap (same values).

- [ ] **Step 4: Run → typecheck + full web suite + build**

Run: `pnpm --filter @loom/web typecheck && pnpm --filter @loom/web test && pnpm --filter @loom/web build`
Expected: typecheck clean; all web tests pass (Storyline render unchanged); build succeeds.

- [ ] **Step 5: Commit**:
```bash
git add packages/web/src/components/Storyline.tsx packages/web/src/components/LogStrip.tsx packages/web/src/components/GenerateFlow.tsx
git commit -m "refactor(web): adopt design-system primitives in Storyline/LogStrip/GenerateFlow"
```

---

## Final verification

- [ ] `pnpm -r typecheck && NODE_OPTIONS=--experimental-sqlite pnpm -r test && pnpm -r build` → all green.

## Self-review notes

- **Spec coverage:** §4.1 primitives → Task 1. §4.2 tokens.css a11y/`--accent` → Task 1. §4.3 adoption → Task 2. §6 tests → Task 1 (primitives) + Task 2 (Storyline regression). §7 follow-ups (big files, SVG/canvas motion) explicitly deferred.
- **Type consistency:** `glassPanel`/`RADIUS`/`SPACE`/`FONT`/`TONE` defined in Task 1, consumed in Task 2.
- **Look preserved:** glassPanel reproduces the exact prior recipe; radii/gaps unchanged; `TONE.good` = `var(--accent)` = the same `oklch(0.62 0.14 160)` Storyline used inline. No visual change expected (only consolidation + opt-in a11y).
- **Unverifiable-in-sandbox:** the actual rendered look — mitigated by reproducing identical computed styles + the primitives unit test + the Storyline render test. Browser-only aesthetic tuning is explicitly out of scope (§7).
