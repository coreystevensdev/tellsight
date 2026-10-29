import type { Response } from 'express';

import { AI_TIMEOUT_MS } from 'shared/constants';
import { deregister, register } from '../../lib/activeStreams.js';

export class StreamSession {
  readonly abortController = new AbortController();
  private readonly timeout: ReturnType<typeof setTimeout>;
  private didTimeOut = false;
  private didDisconnect = false;
  private didEnd = false;

  constructor(private readonly res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    register(this.abortController);
    this.timeout = setTimeout(() => {
      this.didTimeOut = true;
      this.abortController.abort();
    }, AI_TIMEOUT_MS);

    // The request's close event fires after Express drains its body. The
    // response only closes early when the client actually disconnects.
    res.on('close', () => {
      if (res.writableEnded) return;
      this.didDisconnect = true;
      deregister(this.abortController);
      this.abortController.abort();
      this.clearDeadline();
    });
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get timedOut(): boolean {
    return this.didTimeOut;
  }

  get clientDisconnected(): boolean {
    return this.didDisconnect;
  }

  get ended(): boolean {
    return this.didEnd;
  }

  clearDeadline(): void {
    clearTimeout(this.timeout);
  }

  abort(): void {
    this.abortController.abort();
  }

  end(): void {
    if (this.didEnd) return;
    this.didEnd = true;
    deregister(this.abortController);
    this.res.end();
  }

  deregister(): void {
    deregister(this.abortController);
  }
}
