export interface ServiceStatus {
  status: 'ok' | 'degraded' | 'error';
  latencyMs: number;
  /** Why the database check failed. Absent when it did not. */
  reason?: 'connection' | 'schema';
  /** Which required tables were absent. Admin surfaces only, never the public probe. */
  missing?: string[];
}

export interface SystemHealth {
  services: {
    database: ServiceStatus;
    redis: ServiceStatus;
    claude: ServiceStatus;
  };
  uptime: {
    seconds: number;
    formatted: string;
  };
  timestamp: string;
}
