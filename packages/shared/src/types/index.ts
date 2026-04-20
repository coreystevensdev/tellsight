export type {
  Role,
  User,
  Org,
  UserOrg,
  CreateUser,
  CreateOrg,
  JwtPayload,
  GoogleCallback,
  LoginResponse,
} from './auth';

export type {
  SourceType,
  DemoModeState,
  Dataset,
  DataRow,
  ColumnValidationError,
  CsvPreviewData,
  CsvValidationError,
} from './datasets';

export type {
  Granularity,
  RevenueTrendPoint,
  ExpenseBreakdownItem,
  MonthlyComparisonPoint,
  YoyComparisonPoint,
  DatasetDateRange,
  ChartData,
  ChartFilters,
} from './charts';

export type {
  SseTextEvent,
  SseDoneEvent,
  SseErrorEvent,
  SsePartialEvent,
  SseUpgradeRequiredEvent,
} from './sse';

export type { SubscriptionTier } from './subscription';

export type { TransparencyMetadata } from './transparency';

export type { ServiceStatus, SystemHealth } from './admin';

export type { BusinessProfile, OrgFinancials } from '../schemas/businessProfile';

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}
