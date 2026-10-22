// Server Components only. Client Components use api-client.ts (BFF proxy).
import { headers } from 'next/headers';

import type { ApiResponse } from 'shared/types';

import { webEnv } from './config';

const API_INTERNAL_URL = webEnv.API_INTERNAL_URL;

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
  // Express keys its IP rate limits on req.ip, and a server-rendered page
  // reaches it from the web container, so without this every visitor shares one
  // bucket. A dashboard render costs 8 points against a 60/min tier, which
  // capped the whole site at 7 views a minute. Safe to read here because every
  // caller is a page that already awaits cookies().
  const callerAddress = (await headers()).get('x-forwarded-for');

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.cookies ? { Cookie: options.cookies } : {}),
        ...options?.headers,
        ...(callerAddress ? { 'x-forwarded-for': callerAddress } : {}),
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
