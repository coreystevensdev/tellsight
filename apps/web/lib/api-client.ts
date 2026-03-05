/**
 * API client for Client Components.
 * All requests go through the Next.js BFF proxy at /api/*
 * which forwards to the Express API with cookie passthrough.
 *
 * Includes silent refresh: on 401, attempts token refresh then retries once.
 *
 * NEVER use this in Server Components — use api-server.ts instead.
 */

const API_BASE = '/api';

interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
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
    try {
      const errorBody = (await response.json()) as ApiError;
      if (errorBody.error?.message) msg = errorBody.error.message;
    } catch {
      // non-JSON response from proxy errors, gateway timeouts
    }
    throw new Error(msg);
  }

  return response.json() as Promise<ApiResponse<T>>;
}
