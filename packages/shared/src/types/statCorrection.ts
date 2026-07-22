export type StatCorrectionStatus = 'pending' | 'approved' | 'rejected' | 'expired';

// Wire shape for both tiers. Tier 1 rows carry status: null; Tier 2 rows
// carry the full pending/approved/rejected/expired lifecycle.
export interface StatCorrection {
  id: number;
  datasetId: number;
  statInstanceId: string;
  note: string;
  appliesGoingForward: boolean;
  status: StatCorrectionStatus | null;
  createdAt: string;
  expiresAt: string | null;
}
