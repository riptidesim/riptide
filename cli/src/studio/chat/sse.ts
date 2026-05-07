// Tiny Server-Sent Events writer over node:http's ServerResponse.
//
// One instance wraps one open response. Owns header negotiation, JSON
// framing, periodic keep-alive comments, and a clean shutdown that the
// route uses on terminal events or on client disconnect.

import type { ServerResponse } from "node:http";

import type { ChatStreamEvent } from "./types.js";

const KEEPALIVE_INTERVAL_MS = 15_000;

export class SseSink {
  private readonly res: ServerResponse;
  private keepalive: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(res: ServerResponse) {
    this.res = res;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      // Bypass any reverse-proxy buffering (nginx, etc.).
      "x-accel-buffering": "no"
    });
    // Flush headers immediately so the client knows the stream is open.
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as { flushHeaders: () => void }).flushHeaders();
    }
    this.keepalive = setInterval(() => {
      if (this.closed) return;
      this.res.write(":keep-alive\n\n");
    }, KEEPALIVE_INTERVAL_MS);
    // If the keep-alive timer is the only thing holding the loop open, let
    // the process exit anyway — SSE shouldn't block shutdown.
    this.keepalive?.unref?.();

    res.once("close", () => this.close());
  }

  writeEvent(event: ChatStreamEvent): void {
    if (this.closed) return;
    const payload = JSON.stringify(event.data);
    this.res.write(`event: ${event.name}\n`);
    this.res.write(`data: ${payload}\n\n`);
  }

  writeComment(text: string): void {
    if (this.closed) return;
    // SSE comments start with ':' and are ignored by the EventSource API.
    const safe = text.replace(/[\r\n]+/g, " ");
    this.res.write(`:${safe}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    try {
      this.res.end();
    } catch {
      // The socket may already be torn down by the peer; nothing to do.
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}
