import { AppError } from './appError.js';
import { logger } from './logger.js';
import { circuitBreakerState } from './metrics.js';

type State = 'closed' | 'open' | 'half-open';

interface CircuitBreakerOpts {
  name: string;
  threshold: number;    // failures before tripping
  cooldownMs: number;   // time before half-open probe
  isIgnored?: (err: unknown) => boolean; // errors that shouldn't trip the breaker
}

export class CircuitBreaker {
  private state: State = 'closed';
  private failures = 0;
  private lastFailure = 0;
  private readonly name: string;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly isIgnored: (err: unknown) => boolean;

  constructor(opts: CircuitBreakerOpts) {
    this.name = opts.name;
    this.threshold = opts.threshold;
    this.cooldownMs = opts.cooldownMs;
    this.isIgnored = opts.isIgnored ?? (() => false);
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure >= this.cooldownMs) {
        this.state = 'half-open';
        logger.info({ breaker: this.name }, 'circuit half-open, sending probe');
      } else {
        throw new CircuitOpenError(this.name);
      }
    } else if (this.state === 'half-open') {
      // A probe is already awaiting. Every exit from half-open lands in closed or
      // open, including the ignored-error arm below, so reaching here means the
      // first caller has not come back yet. Letting this one through would make
      // it a second probe against an upstream we still believe is down, which is
      // the load we are meant to be shedding.
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      // An ignored error says nothing either way about the upstream. Left alone it
      // strands the breaker in half-open, where the gate above rejects nothing, so
      // a spent probe goes back to open and waits out another cooldown. That costs
      // recovery latency when the ignored error was a cost refusal, since that one
      // implies the call did reach Claude, but the breaker cannot tell the two
      // apart through a single isIgnored predicate.
      if (this.isIgnored(err)) {
        if (this.state === 'half-open') {
          this.state = 'open';
          this.lastFailure = Date.now();
          logger.info({ breaker: this.name }, 'circuit re-opened, probe was inconclusive');
        }
      } else {
        this.onFailure();
      }
      throw err;
    }
  }

  private onSuccess() {
    if (this.state === 'half-open') {
      logger.info({ breaker: this.name }, 'circuit closed, probe succeeded');
    }
    this.failures = 0;
    this.state = 'closed';
    circuitBreakerState.set({ name: this.name }, 0);
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.failures >= this.threshold && this.state !== 'open') {
      this.state = 'open';
      circuitBreakerState.set({ name: this.name }, 1);
      logger.warn(
        { breaker: this.name, failures: this.failures, cooldownMs: this.cooldownMs },
        'circuit opened, requests will fail fast',
      );
    }
  }

  isOpen(): boolean {
    return this.state === 'open';
  }
}

// 503 rather than 502: the upstream may be perfectly healthy, we are shedding on
// purpose. The breaker name is a field instead of part of the message because
// errorHandler returns an AppError's message to the caller verbatim, and which
// internal breaker tripped is not the caller's business.
export class CircuitOpenError extends AppError {
  readonly breaker: string;

  constructor(breaker: string) {
    super('Service temporarily unavailable, please retry shortly.', 'CIRCUIT_OPEN', 503);
    this.breaker = breaker;
  }
}
