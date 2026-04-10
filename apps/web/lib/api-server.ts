/**
 * API client for Server Components.
 * Calls the Express API directly via Docker internal networking.
 *
 * NEVER use this in Client Components — use api-client.ts instead.
 */

import { webEnv } from './config';

const API_INTERNAL_URL = webEnv.API_INTERNAL_URL;

interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiServerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiServerError';
  }
}

export async function apiServer<T>(
  path: string,
  options?: RequestInit & { cookies?: string },
): Promise<ApiResponse<T>> {
  const url = `${API_INTERNAL_URL}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.cookies ? { Cookie: options.cookies } : {}),
        ...options?.headers,
      },
      cache: 'no-store',
    });
  } catch (err) {
    throw new ApiServerError('NETWORK_ERROR', 'API request failed', 0, { cause: err });
  }

  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // non-JSON response (timeouts, proxy errors, etc.)
    }

    throw new ApiServerError(
      body?.error?.code ?? 'UNKNOWN_ERROR',
      body?.error?.message ?? `API error: ${response.status}`,
      response.status,
      body?.error?.details,
    );
  }

  return response.json() as Promise<ApiResponse<T>>;
}
