export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 'AUTHENTICATION_REQUIRED', 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 'NOT_FOUND', 404);
  }
}

export class QuotaExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'QUOTA_EXCEEDED', 402, details);
  }
}

// Closed union of valid service names. Typing the constructor arg as this
// union means a typo at the throw site fails at compile time instead of
// silently fragmenting Sentry issues. Add a new entry here before throwing
// from a new vendor integration.
export type ExternalService =
  | 'Stripe'
  | 'Claude API'
  | 'Google OAuth'
  | 'Intuit OAuth'
  | 'Intuit OAuth, token revoked';

export class ExternalServiceError extends AppError {
  readonly service: ExternalService;

  constructor(service: ExternalService, details?: unknown) {
    super(`External service error: ${service}`, 'EXTERNAL_SERVICE_ERROR', 502, details);
    this.service = service;
  }
}

// Operator-side safety guard, not a user-tier issue. Use 503 because the user
// did nothing wrong, we refused the call to protect a shared budget. Distinct
// from QuotaExceededError (402, user needs to upgrade) and from
// ExternalServiceError (502, upstream actually failed). The cost was real
// and incurred; this error documents that we caught it post-hoc.
export class CostBudgetExceededError extends AppError {
  readonly observedUsd: number;
  readonly capUsd: number | null;

  constructor(observedUsd: number, capUsd: number | null) {
    super(
      `AI request cost $${observedUsd.toFixed(4)} exceeded safety cap $${capUsd?.toFixed(4) ?? 'unknown'}.`,
      'COST_BUDGET_EXCEEDED',
      503,
      { observedUsd, capUsd },
    );
    this.observedUsd = observedUsd;
    this.capUsd = capUsd;
  }
}

// For invariants the server should uphold, not user-facing auth failures.
// Use this when the cause is misconfigured code (missing middleware, unreachable
// branch) rather than a bad request. Two audiences, two messages:
//   - devMessage: the specific bug, for logs and Sentry
//   - client-facing message: a generic 500 so we don't leak implementation
// The error handler picks the right one for the right sink.
export class ProgrammerError extends AppError {
  readonly devMessage: string;

  constructor(devMessage: string) {
    super('An unexpected error occurred', 'INTERNAL_SERVER_ERROR', 500);
    this.devMessage = devMessage;
  }
}
