/**
 * API client for Client Components.
 * All requests go through the Next.js BFF proxy at /api/*
 * which forwards to the Express API with cookie passthrough.
 *
 * Includes silent refresh: on 401, attempts token refresh then retries once.
 *
 * NEVER use this in Server Components, use api-server.ts instead.
 */

import type { ApiResponse } from 'shared/types';

const API_BASE = '/api';

interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function apiClient<T>(
  path: string,
  options?: RequestInit,
): Promise<ApiResponse<T>> {
  const url = `${API_BASE}${path}`;
  const fetchOptions: RequestInit = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include',
  };

  let response = await fetch(url, fetchOptions);

  if (response.status === 401) {
    // Deduplicate concurrent refresh attempts
    if (!refreshPromise) {
      refreshPromise = attemptRefresh().finally(() => {
        refreshPromise = null;
      });
    }

    const refreshed = await refreshPromise;
    if (refreshed) {
      response = await fetch(url, fetchOptions);
    }
  }

  if (!response.ok) {
    let msg = `API error: ${response.status}`;
    let code: string | null = null;
    try {
      const errorBody = (await response.json()) as ApiError;
      if (errorBody.error?.message) msg = errorBody.error.message;
      if (errorBody.error?.code) code = errorBody.error.code;
    } catch {
      // non-JSON response from proxy errors, gateway timeouts
    }
    throw new ApiClientError(msg, response.status, code);
  }

  return response.json() as Promise<ApiResponse<T>>;
}
