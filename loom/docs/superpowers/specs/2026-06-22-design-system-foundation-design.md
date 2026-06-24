# Fundação de design system (slice D v1)

**Data:** 2026-06-22
**Status:** design aprovado para plano
**Slice:** D (estética viva) do roadmap "democratizar + humanizar o gerenciamento de loops" — **v1: fundação**

---

## 1. Problema

A UI do Loom é um porte 1:1 de um mockup, com **estilos inline espalhados**: o mesmo "glass panel" (`background var(--glass)` + `backdropFilter blur(22px) saturate(1.4)` + `border var(--glass-border)` + `boxShadow`) está repetido verbatim em LogStrip, Inspector, CanvasOverlay e Storyline; raios (9/12/15), espaçamentos e tamanhos de fonte são magic numbers repetidos; cores semânticas (good/warn/bad) estão hardcoded na Storyline. Além disso o `tokens.css` **não** respeita `prefers-reduced-motion` (blobs e pulsos animam sempre) e não há estado de **foco visível** para acessibilidade.

Isso torna qualquer ajuste estético futuro caro e inconsistente. A fundação resolve a raiz sem redesenhar nada.

> **Restrição honesta:** este slice é estético, mas o ambiente de execução não abre o browser (WSL→Windows). Logo v1 é deliberadamente **objetivo e verificável** (módulo puro + CSS + testes); o ajuste fino subjetivo de aparência fica para o usuário no browser, sobre esta base.

## 2. Objetivo e não-objetivos

**Objetivo:** um módulo de **primitivos de design** + ganhos de acessibilidade no CSS global, adotados nas superfícies de baixo risco.

**Critérios de sucesso:**
1. `theme/primitives.ts` exporta `glassPanel()`, escalas `RADIUS`/`SPACE`/`FONT` e `TONE`, com testes unitários.
2. `tokens.css` respeita `prefers-reduced-motion` (desliga as animações decorativas) e tem `:focus-visible` global.
3. Storyline, GenerateFlow e LogStrip passam a usar os primitivos; seus testes continuam verdes (sem regressão de comportamento).
4. typecheck + build + toda a suíte verdes.

**Não-objetivos (YAGNI v1):**
- Redesenhar/retematizar qualquer superfície (o visual 1:1 do mockup é preservado).
- Tocar os arquivos grandes (CanvasOverlay, Inspector, TopBar) — adoção neles é **follow-up** (risco de regressão visual que não consigo inspecionar aqui).
- Novos componentes visuais, motion novo, ou mudança de paleta.

## 3. Arquitetura

```
theme/tokens.css      ← variáveis de tema (existente) + @media reduced-motion + :focus-visible (NOVO)
theme/primitives.ts   ← NOVO, puro: glassPanel(), RADIUS, SPACE, FONT, TONE
        ▲
        │ import
LogStrip · Storyline · GenerateFlow   ← adotam os primitivos (superfícies pequenas, de baixo risco)

(CanvasOverlay · Inspector · TopBar    ← NÃO tocados em v1; adoção documentada como follow-up)
```

`primitives.ts` é puro (sem React/DOM): funções e constantes que devolvem `CSSProperties`/strings. Testável isoladamente. Reusa as CSS variables existentes (`var(--glass)`, etc.) — **não** reintroduz cores hardcoded; o `TONE` centraliza as oklch semânticas que hoje estão na Storyline.

## 4. Componentes (interfaces)

### 4.1 `theme/primitives.ts` (NOVO)

```ts
import type { CSSProperties } from "react";
import type { NarrationTone } from "@loom/shared";

/** Canonical 22px "glass panel" surface (the verbatim-repeated style). Merge
 *  overrides on top (e.g. width, padding) without restating the glass recipe. */
export function glassPanel(overrides?: CSSProperties): CSSProperties;

/** Corner radii used across the UI (sm/md/lg = 9/12/15). */
export const RADIUS: { sm: 9; md: 12; lg: 15 };

/** Spacing scale (px) for gaps/padding. */
export const SPACE: { xs: 4; sm: 8; md: 13; lg: 16 };

/** Font sizes (px) for the recurring tiers. */
export const FONT: { xs: 10.5; sm: 11.5; md: 12.5; lg: 13 };

/** Semantic tone → color (good/warn/bad/neutral). Centralizes the oklch values
 *  that were hardcoded in Storyline; reusable by any tone-coded surface.
 *  good = var(--accent); warn = oklch(0.78 0.13 80); bad = oklch(0.62 0.18 25);
 *  neutral = var(--line2). */
export const TONE: Record<NarrationTone, string>;
```

`glassPanel()` returns exactly the canonical recipe:
```
{ background: "var(--glass)", backdropFilter: "blur(22px) saturate(1.4)",
  WebkitBackdropFilter: "blur(22px) saturate(1.4)", border: "1px solid var(--glass-border)",
  boxShadow: "0 10px 40px -16px rgba(30,55,45,0.18),inset 0 1px 0 rgba(255,255,255,0.7)",
  borderRadius: RADIUS.lg }
```
merged with `overrides` (overrides win).

### 4.2 `tokens.css` additions

- `@media (prefers-reduced-motion: reduce)` → neutralize the decorative keyframes:
  ```
  @media (prefers-reduced-motion: reduce) {
    [data-loom] *, [data-loom] *::before, [data-loom] *::after {
      animation-duration: .001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .001ms !important;
    }
  }
  ```
- Introduce a shared **`--accent`** token (today the accent green `oklch(0.62 0.14 160)` lives only as a JS constant `ACCENT` in LeftRail and inline in Storyline). Add `--accent: oklch(0.62 0.14 160);` to BOTH the light (`:root`/`[data-theme="light"]`) and dark blocks in tokens.css.
- Global focus-visible ring (keyboard users), scoped under `[data-loom]`, using the new token:
  ```
  [data-loom] :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  ```

### 4.3 Adoption (low-risk surfaces only)

- **Storyline.tsx:** `PANEL_STYLE` → `glassPanel({ width: 300, flex: "none", display: "flex", flexDirection: "column", overflow: "hidden" })`; `TONE_DOT` → `TONE`.
- **GenerateFlow.tsx:** use `RADIUS`/`FONT` for the button/textarea radii + sizes (no glass there).
- **LogStrip.tsx:** `STRIP_STYLE` → `glassPanel({ display: "flex", alignItems: "center", gap: SPACE.lg, padding: "9px 16px" })`.

Behavior is unchanged (same computed styles); these are the surfaces with co-located, small files where a careful swap is safe and their tests guard against regression.

## 5. Erros e bordas

- `glassPanel(overrides)` with conflicting keys → overrides win (documented). Without overrides → the bare canonical recipe.
- Reduced-motion media query is additive — users without the preference are unaffected.
- `:focus-visible` only shows on keyboard focus (not mouse), so it does not change the mouse-driven look.

## 6. Testes

1. **`primitives.test.ts`:** `glassPanel()` returns an object containing the canonical glass keys (`background`, `backdropFilter`, `border`, `boxShadow`, `borderRadius`); `glassPanel({ width: 300 })` includes `width: 300` AND the glass keys; an override of a glass key wins; `TONE` has all four tones (`neutral`/`good`/`warn`/`bad`) as non-empty strings; `RADIUS.lg === 15`.
2. **Regression:** the existing `Storyline.test.tsx` + `LogStrip` (if it has one — else just typecheck) stay green after adoption.
3. typecheck + build.

## 7. Fora de escopo / follow-up

- Adoção dos primitivos nos arquivos grandes (CanvasOverlay/Inspector/TopBar) — quando o usuário puder validar visualmente no browser.
- Ajuste fino subjetivo (paleta, motion "vivo", micro-interações) — direção estética com o usuário no browser.
- Reduced-motion para os pulsos/glow desenhados em SVG/canvas (CanvasGraph/Overlay calculam motion em JS via `tick()`), que a media query CSS não cobre — follow-up (precisaria checar `matchMedia` no loop de animação).

## 8. Impacto na base

- Adições: 1 módulo (`primitives.ts`) + 1 teste + 2 blocos em `tokens.css`. Edições pequenas em 3 componentes nossos. Nenhuma mudança de comportamento; o visual 1:1 é preservado. Arquivos grandes intocados.
