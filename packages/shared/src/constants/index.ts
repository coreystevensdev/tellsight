export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const AI_TIMEOUT_MS = 15_000; // 15s total, TTFT < 2s
export const FREE_PREVIEW_WORD_LIMIT = 50;

// Anthropic API pricing per 1M tokens (Sonnet 4.5 default, model configured
// via CLAUDE_MODEL env var, defaulting to claude-sonnet-4-5-20250929). These
// are estimates for the admin dashboard cost tile, NOT billing. Update when
// the default model changes or Anthropic publishes new rates.
export const CLAUDE_PRICING = {
  'claude-sonnet-4-5-20250929': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },
  'claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75 },
} as const;

export const DEFAULT_CLAUDE_MODEL_ID = 'claude-sonnet-4-5-20250929' as const;

export function estimateClaudeCostUsd(
  inputTokens: number,
  outputTokens: number,
  modelId: keyof typeof CLAUDE_PRICING = DEFAULT_CLAUDE_MODEL_ID,
): number {
  const rates = CLAUDE_PRICING[modelId];
  return (inputTokens * rates.inputPerMillion + outputTokens * rates.outputPerMillion) / 1_000_000;
}

export const RATE_LIMITS = {
  auth: { max: 10, windowMs: 60_000 },
  ai: { max: 5, windowMs: 60_000 },
  public: { max: 60, windowMs: 60_000 },
  // Authenticated endpoints that do non-trivial compute per request (SQL
  // aggregations, regression math, etc.) but aren't LLM-gated. User-keyed,
  // generous enough for page load + occasional refresh (~3-5/min typical),
  // tight enough to catch loop-bug or abuse patterns (60+/min).
  dashboardCompute: { max: 30, windowMs: 60_000 },
} as const;

export const ROLES = {
  OWNER: 'owner',
  MEMBER: 'member',
} as const;

export const INVITES = {
  DEFAULT_EXPIRY_DAYS: 7,
  TOKEN_BYTES: 32,
} as const;

export const SHARES = {
  DEFAULT_EXPIRY_DAYS: 30,
  TOKEN_BYTES: 32,
} as const;

// dot-notation past-tense, matches the pattern in analytics_events.event_name
export const ANALYTICS_EVENTS = {
  USER_SIGNED_UP: 'user.signed_up',
  USER_SIGNED_IN: 'user.signed_in',
  USER_SIGNED_OUT: 'user.signed_out',
  ORG_CREATED: 'org.created',
  ORG_INVITE_SENT: 'org.invite_sent',
  ORG_INVITE_ACCEPTED: 'org.invite_accepted',
  DATASET_UPLOADED: 'dataset.uploaded',
  DATASET_CONFIRMED: 'dataset.confirmed',
  DATASET_DELETED: 'dataset.deleted',
  AI_SUMMARY_REQUESTED: 'ai.summary_requested',
  AI_SUMMARY_COMPLETED: 'ai.summary_completed',
  AI_SUMMARY_VALIDATION_FLAGGED: 'ai.summary_validation_flagged',
  AI_CHART_REF_INVALID: 'ai.chart_ref_invalid',
  INSIGHT_CHART_OPENED: 'insight.chart_opened',
  SHARE_LINK_CREATED: 'share_link.created',
  INSIGHT_EXPORTED: 'insight.exported',
  DASHBOARD_VIEWED: 'dashboard.viewed',
  CHART_FILTERED: 'chart.filtered',
  AI_PREVIEW_VIEWED: 'ai_preview.viewed',
  SUBSCRIPTION_UPGRADE_INTENDED: 'subscription.upgrade_intended',
  SUBSCRIPTION_UPGRADED: 'subscription.upgraded',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  SUBSCRIPTION_PAYMENT_FAILED: 'subscription.payment_failed',
  SUBSCRIPTION_EXPIRED: 'subscription.expired',
  SUBSCRIPTION_STATUS_CHECKED: 'subscription.status_checked',
  TRANSPARENCY_PANEL_OPENED: 'transparency_panel.opened',
  DATASET_RENAMED: 'dataset.renamed',
  DATASET_ACTIVATED: 'dataset.activated',
  INTEGRATION_CONNECTED: 'integration.connected',
  INTEGRATION_DISCONNECTED: 'integration.disconnected',
  INTEGRATION_SYNCED: 'integration.synced',
  INTEGRATION_SYNC_FAILED: 'integration.sync_failed',
  DIGEST_SENT: 'digest.sent',
  DIGEST_FAILED: 'digest.failed',
  DIGEST_TEASER_SENT: 'digest.teaser_sent',
  DIGEST_PREFERENCE_CHANGED: 'digest.preference_changed',
  FINANCIALS_UPDATED: 'financials.updated',
  FORECAST_REQUESTED: 'forecast.requested',
  RUNWAY_ENABLED: 'runway.enabled',
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

// Inline chart-reference token emitted by the LLM to bind a paragraph to a
// chart, see Story 8.5. Centralized here so every consumer (validator,
// stream hook, post-stream parser, shared-link strip, OG metadata strip)
// sees the same definition. If the token shape ever changes, this is the
// only file that needs to know.
//
// Factory-style exports because a shared RegExp with the /g flag carries
// lastIndex state across uses, each caller gets a fresh regex.
export function statTagGlobal(): RegExp {
  return /<stat\s+id="\w+"\s*\/>/g;
}
export function statTagCapture(): RegExp {
  return /<stat\s+id="(\w+)"\s*\/>/g;
}
export function statTagOpenFragment(): RegExp {
  return /<stat(?:\s[^>]*)?$/;
}

// Convenience: strip all fully-formed <stat id="..."/> tokens from text.
// Does NOT handle boundary-split fragments, that's useAiStream's concern
// (mid-stream UX) and this helper is for post-stream or server-side calls
// where the full text is already in hand.
export function stripAllStatTags(text: string): string {
  return text.replace(statTagGlobal(), '');
}

export const AUTH = {
  ACCESS_TOKEN_EXPIRY: '15m',
  REFRESH_TOKEN_EXPIRY_DAYS: 7,
  OAUTH_STATE_EXPIRY_SECONDS: 600,
  COOKIE_NAMES: {
    ACCESS_TOKEN: 'access_token',
    REFRESH_TOKEN: 'refresh_token',
    OAUTH_STATE: 'oauth_state',
  },
  GOOGLE_AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GOOGLE_JWKS_URL: 'https://www.googleapis.com/oauth2/v3/certs',
  GOOGLE_SCOPES: 'openid email profile',
} as const;

export const SEED_ORG = {
  slug: 'seed-demo',
  name: 'Sunrise Cafe',
} as const;

export const AI_MONTHLY_QUOTA = {
  free: 3,
  pro: 100,
} as const;

export const MAX_DATASETS_PER_ORG = 20;

export const CSV_REQUIRED_COLUMNS = ['date', 'amount', 'category'] as const;
export const CSV_OPTIONAL_COLUMNS = ['label', 'parent_category'] as const;
export const CSV_MAX_ROWS = 50_000;
export const ACCEPTED_FILE_TYPES = ['.csv', 'text/csv', 'application/vnd.ms-excel'] as const;

export const CHART_CONFIG = {
  ANIMATION_DURATION_MS: 500,
  ANIMATION_EASING: 'ease-in-out' as const,
  SKELETON_PULSE_MS: 1500,
  RESIZE_DEBOUNCE_MS: 200,
  LAZY_THRESHOLD: 0.1,
  SKELETON_FADE_MS: 150,
} as const;

export const AUDIT_ACTIONS = {
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_TOKEN_REFRESHED: 'auth.token_refreshed',
  ORG_INVITE_SENT: 'org.invite_sent',
  ORG_INVITE_ACCEPTED: 'org.invite_accepted',
  ORG_MEMBER_REMOVED: 'org.member_removed',
  DATASET_UPLOADED: 'dataset.uploaded',
  DATASET_DELETED: 'dataset.deleted',
  DATASET_RENAMED: 'dataset.renamed',
  SUBSCRIPTION_CHECKOUT: 'subscription.checkout',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  INTEGRATION_CONNECTED: 'integration.connected',
  INTEGRATION_DISCONNECTED: 'integration.disconnected',
  ADMIN_ORG_VIEWED: 'admin.org_viewed',
  SETTINGS_DIGEST_CHANGED: 'settings.digest_changed',
  SHARE_CREATED: 'share.created',
  FINANCIALS_UPDATED: 'financials.updated',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AI_DISCLAIMER =
  'AI-generated analysis, not financial advice. Verify with your accountant.' as const;

export const DEMO_MODE_STATES = {
  SEED_ONLY: 'seed_only',
  SEED_PLUS_USER: 'seed_plus_user',
  USER_ONLY: 'user_only',
  EMPTY: 'empty',
} as const;
