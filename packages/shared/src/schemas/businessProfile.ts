import { z } from 'zod';

export const BUSINESS_TYPES = [
  'restaurant',
  'retail',
  'services',
  'construction',
  'healthcare',
  'technology',
  'manufacturing',
  'real_estate',
  'transportation',
  'other',
] as const;

export const REVENUE_RANGES = [
  'under_100k',
  '100k_500k',
  '500k_2m',
  'over_2m',
] as const;

export const TEAM_SIZES = [
  'solo',
  '2_5',
  '6_20',
  'over_20',
] as const;

export const TOP_CONCERNS = [
  'cash_flow',
  'growth',
  'cost_control',
  'seasonal_planning',
  'profitability',
] as const;

export const businessProfileSchema = z.object({
  businessType: z.enum(BUSINESS_TYPES),
  revenueRange: z.enum(REVENUE_RANGES),
  teamSize: z.enum(TEAM_SIZES),
  topConcern: z.enum(TOP_CONCERNS),
  // Financial baseline fields (Story 8.2+). All optional so existing rows deserialize.
  // cashOnHand / cashAsOfDate / businessStartedDate land in 8.2; monthlyFixedCosts in 8.3.
  cashOnHand: z.number().positive().max(999_999_999).optional(),
  cashAsOfDate: z.string().datetime().optional(),
  businessStartedDate: z.string().date().optional(),
  monthlyFixedCosts: z.number().nonnegative().optional(),
});

export type BusinessProfile = z.infer<typeof businessProfileSchema>;

// Narrower subset for the /api/org/financials endpoints. Keeps runway/break-even
// concerns separate from onboarding concerns.
export const orgFinancialsSchema = businessProfileSchema.pick({
  cashOnHand: true,
  cashAsOfDate: true,
  businessStartedDate: true,
  monthlyFixedCosts: true,
});

export type OrgFinancials = z.infer<typeof orgFinancialsSchema>;
