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

export class ExternalServiceError extends AppError {
  constructor(service: string, details?: unknown) {
    super(`External service error: ${service}`, 'EXTERNAL_SERVICE_ERROR', 502, details);
  }
}
