export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const AI_TIMEOUT_MS = 15_000; // 15s total, TTFT < 2s
export const FREE_PREVIEW_WORD_LIMIT = 50;

export const RATE_LIMITS = {
  auth: { max: 10, windowMs: 60_000 },
  ai: { max: 5, windowMs: 60_000 },
  public: { max: 60, windowMs: 60_000 },
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

// dot-notation past-tense — matches the pattern in analytics_events.event_name
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
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

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

export const DEMO_MODE_STATES = {
  SEED_ONLY: 'seed_only',
  SEED_PLUS_USER: 'seed_plus_user',
  USER_ONLY: 'user_only',
  EMPTY: 'empty',
} as const;
