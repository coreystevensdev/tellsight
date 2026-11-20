// Explicit acceptance requirements, shared by the live harness and gate tests.
// Risk coverage includes silence: at least 80% of warranted material risks must
// be flagged. Fixtures with no warranted risk have null coverage and are exempt.
export const EVAL_FLOORS = { faithfulness: 0.85, completeness: 0.8, riskCoverage: 0.8 };
