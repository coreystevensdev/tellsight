// Client Components only. Server Components use api-server.ts (direct internal network call).
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

async function postRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    // 409 is REFRESH_RACE: another tab rotated the same token a moment ago and
    // its Set-Cookie has landed in the jar this request shares. The session is
    // usable, so report success and let the caller retry the original request.
    // Not retried here, because retrying would present the token the winner
    // just revoked, and that is the reuse path that logs every device out.
    return response.ok || response.status === 409;
  } catch {
    return false;
  }
}

// The refresh token rotates on every use, so concurrent 401s have to share one
// in-flight refresh or the losers present an already-rotated token and get logged
// out. The dedup lives here rather than in apiClient() because SSE and XHR callers
// need the same flow and can't route through apiClient().
export function attemptRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = postRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
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

  // fetch rejects with a TypeError on a dropped connection, a DNS failure or a
  // blocked request. Letting that through matters because 41 call sites render
  // `err instanceof Error ? err.message : ...` straight into the page, so the
  // reader was being shown "Failed to fetch".
  let response: Response;
  try {
    response = await fetch(url, fetchOptions);

    if (response.status === 401 && (await attemptRefresh())) {
      response = await fetch(url, fetchOptions);
    }
  } catch {
    throw new ApiClientError(
      'Could not reach the server. Check your connection and try again.',
      0,
      'NETWORK_ERROR',
    );
  }

  if (!response.ok) {
    // Same reason: this default is read by a person, not a log. The status is
    // still on the error for any caller that wants to branch on it.
    let msg = 'The server could not complete that request.';
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
