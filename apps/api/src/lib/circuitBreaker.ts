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
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (!this.isIgnored(err)) this.onFailure();
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

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  constructor(name: string) {
    super(`Circuit breaker "${name}" is open, service unavailable`);
  }
}
