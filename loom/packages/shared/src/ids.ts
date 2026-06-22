// Branded id types — distinct at compile time, plain strings at runtime.
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type FlowId = Brand<string, "FlowId">;
export type NodeId = Brand<string, "NodeId">;
export type EdgeId = Brand<string, "EdgeId">;
export type RunId = Brand<string, "RunId">;

export const asFlowId = (s: string): FlowId => s as FlowId;
export const asNodeId = (s: string): NodeId => s as NodeId;
export const asEdgeId = (s: string): EdgeId => s as EdgeId;
export const asRunId = (s: string): RunId => s as RunId;

/** Short, URL-safe random id with an optional prefix. For CLIENT-side temp ids only. */
export function makeId(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 9);
}

/** Crypto-strong id for ENGINE-side persistent entities (runs, events). Collision-safe. */
export function newId(prefix = ""): string {
  const c: { randomUUID?: () => string } | undefined = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return prefix + c.randomUUID();
  return prefix + Math.random().toString(36).slice(2, 10);
}
