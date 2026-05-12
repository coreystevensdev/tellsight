export interface AdminOrgRow {
  id: number;
  name: string;
  slug: string;
  memberCount: number;
  datasetCount: number;
  subscriptionTier: string | null;
  createdAt: string;
}

export interface ComplianceWindowCounts {
  unsubscribed: number;
  bounced: number;
  complained: number;
  digestsSent: number;
  opened: number;
  clicked: number;
}

export interface EmailComplianceMetrics {
  totalProUsers: number;
  cadenceActiveUsers: number;
  d7: ComplianceWindowCounts;
  d30: ComplianceWindowCounts;
  computedAt: string;
}

export interface AdminUserRow {
  id: number;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  orgs: Array<{ orgId: number; orgName: string; role: string }>;
  createdAt: string;
}

export interface AdminStats {
  totalOrgs: number;
  totalUsers: number;
  proSubscribers: number;
  aiUsage: AiUsageStats;
}

export interface AiUsageStats {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  estimatedCostUsd: number;
}

export interface AnalyticsEventRow {
  id: number;
  eventName: string;
  // Nullable: system-emitted webhook events (Resend bounce/complaint) carry
  // no user/org context; the admin events feed renders these with
  // placeholders ("system" / "<system>").
  orgName: string | null;
  userEmail: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AnalyticsEventsMeta {
  total: number;
  pagination: { page: number; pageSize: number; totalPages: number };
}

export type { ServiceStatus, SystemHealth } from 'shared/types';
