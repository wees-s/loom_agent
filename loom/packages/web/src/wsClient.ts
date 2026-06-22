import type { ServerMessage, ClientCommand, FlowId } from "@loom/shared";
import { useLoomStore } from "./store";

/* ────────────────────────────────────────────────────────────────────────
 * Native-WebSocket transport.
 *
 * - Typed to ServerMessage (inbound) / ClientCommand (outbound).
 * - Buffers outbound commands while disconnected and flushes on open.
 * - Reconnects with capped exponential backoff.
 * - On (re)connect, re-subscribes to the selected flow with `sinceSeq` so the
 *   engine replays only the events we missed (the StoredEvent.seq cursor lives
 *   in the store as `lastSeq`).
 *
 * No external ws library — browser-native WebSocket only.
 * ──────────────────────────────────────────────────────────────────────── */

export interface WsClientOptions {
  url: string;
  /** base reconnect delay (ms); doubles each attempt up to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_BACKOFF = 500;
const DEFAULT_MAX_BACKOFF = 10_000;

export class LoomWsClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private attempt = 0;
  private outbox: ClientCommand[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(opts: WsClientOptions) {
    this.url = opts.url;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;
  }

  connect(): void {
    this.closedByUser = false;
    const store = useLoomStore.getState();
    store.setConnection(this.attempt === 0 ? "connecting" : "reconnecting");
    // route all store-emitted commands through this socket
    store.attachTransport((cmd) => this.send(cmd));

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.resync();
      this.flush();
    };

    ws.onmessage = (ev: MessageEvent) => {
      const msg = this.parse(ev.data);
      if (msg) useLoomStore.getState().applyServerMessage(msg);
    };

    ws.onerror = () => {
      // onclose handles reconnect; nothing actionable here.
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.closedByUser) {
        useLoomStore.getState().setConnection("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Send (or buffer) a typed command. */
  send(cmd: ClientCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    } else {
      this.outbox.push(cmd);
    }
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Re-subscribe to the selected flow from our last folded seq. */
  private resync(): void {
    const { selectedFlowId, lastSeq } = useLoomStore.getState();
    if (selectedFlowId) {
      this.send({ t: "subscribe", flowId: selectedFlowId as FlowId, sinceSeq: lastSeq });
    }
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pending = this.outbox;
    this.outbox = [];
    for (const cmd of pending) this.ws.send(JSON.stringify(cmd));
  }

  private parse(data: unknown): ServerMessage | null {
    if (typeof data !== "string") return null;
    try {
      const obj = JSON.parse(data) as ServerMessage;
      if (obj && typeof obj === "object" && typeof (obj as { t?: unknown }).t === "string") return obj;
      return null;
    } catch {
      return null;
    }
  }

  private scheduleReconnect(): void {
    useLoomStore.getState().setConnection("reconnecting");
    const delay = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

/** Convenience: build the default ws URL from the current page origin. */
export function defaultWsUrl(): string {
  if (typeof window === "undefined") return "ws://localhost:7733/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host || "localhost:7733";
  return `${proto}//${host}/ws`;
}

/**
 * Wire a client to the store and start connecting. Returns the client so the
 * app can `close()` it on unmount.
 */
export function startWsClient(url: string = defaultWsUrl()): LoomWsClient {
  const client = new LoomWsClient({ url });
  client.connect();
  return client;
}
