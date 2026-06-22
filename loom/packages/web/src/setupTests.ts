import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/* ════════════════════════════════════════════════════════════════════════
 * jsdom polyfills — the canvas (CanvasGraph) leans on browser APIs that jsdom
 * does not implement. WITHOUT these, the component throws inside its RAF tick
 * loop and we would get a FALSE white-screen that masks the real selection bug.
 * We polyfill exactly the surface the canvas math touches, nothing more.
 *
 *   • SVGGeometryElement.getTotalLength / getPointAtLength  (pulse positioning)
 *   • Element.getBoundingClientRect                          (toStage / applyFit)
 *   • window.requestAnimationFrame / cancelAnimationFrame    (tick loop)
 *   • ResizeObserver                                         (applyFit on resize)
 * ════════════════════════════════════════════════════════════════════════ */

/* ── requestAnimationFrame / cancelAnimationFrame ──────────────────────── */
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  }) as typeof requestAnimationFrame;
}
if (typeof globalThis.cancelAnimationFrame !== "function") {
  globalThis.cancelAnimationFrame = ((id: number): void => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }) as typeof cancelAnimationFrame;
}

/* ── ResizeObserver (jsdom has none) ───────────────────────────────────── */
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

/* ── Element.getBoundingClientRect — jsdom returns all-zeros; give the
 *    canvas container a real-looking box so fitScale() produces a finite,
 *    positive scale (it divides by STAGE_W / STAGE_H). ──────────────────── */
const FAKE_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 1200,
  bottom: 800,
  width: 1200,
  height: 800,
  toJSON: () => ({}),
} as DOMRect;

if (typeof Element !== "undefined") {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return FAKE_RECT;
  };
  // jsdom leaves clientWidth/clientHeight at 0; applyFit() early-returns on a
  // 0 width, so give a non-zero size to actually exercise the fit math.
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 1200;
    },
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 800;
    },
  });
}

/* ── SVGGeometryElement geometry — jsdom implements neither getTotalLength
 *    nor getPointAtLength; the pulse loop calls both every frame. ───────── */
type SvgGeomCtor = { prototype: { getTotalLength?: unknown; getPointAtLength?: unknown } };
function patchSvgGeometry(ctor: SvgGeomCtor | undefined): void {
  if (!ctor || !ctor.prototype) return;
  if (typeof ctor.prototype.getTotalLength !== "function") {
    ctor.prototype.getTotalLength = function getTotalLength(): number {
      return 100;
    };
  }
  if (typeof ctor.prototype.getPointAtLength !== "function") {
    ctor.prototype.getPointAtLength = function getPointAtLength(): { x: number; y: number } {
      return { x: 0, y: 0 };
    };
  }
}
patchSvgGeometry((globalThis as { SVGGeometryElement?: SvgGeomCtor }).SVGGeometryElement);
patchSvgGeometry((globalThis as { SVGPathElement?: SvgGeomCtor }).SVGPathElement);

/* ── scrollIntoView (some components call it on update) ─────────────────── */
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

afterEach(() => {
  cleanup();
});
