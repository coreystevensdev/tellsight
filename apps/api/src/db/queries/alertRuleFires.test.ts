import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelectFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockInsertValues = vi.fn();
const mockReturning = vi.fn();

let selectResult: unknown[] = [];
let returningResult: unknown[] = [];

function thenable(getResult: () => unknown[]) {
  return {
    then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(getResult()).then(resolve, reject),
    orderBy: (...o: unknown[]) => {
      mockOrderBy(...o);
      return {
        limit: (...l: unknown[]) => {
          mockLimit(...l);
          return thenableResult();
        },
      };
    },
  };
}

function thenableResult() {
  return {
    then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(selectResult).then(resolve, reject),
  };
}

vi.mock('../../lib/db.js', () => {
  const client = {
    select: () => ({
      from: (...f: unknown[]) => {
        mockSelectFrom(...f);
        return {
          where: (...w: unknown[]) => {
            mockWhere(...w);
            return thenable(() => selectResult);
          },
        };
      },
    }),
    insert: () => ({
      values: (...args: unknown[]) => {
        mockInsertValues(...args);
        return { returning: () => { mockReturning(); return Promise.resolve(returningResult); } };
      },
    }),
  };
  return { dbAdmin: client };
});

vi.mock('../schema.js', () => ({
  alertRuleFires: {
    id: 'id',
    orgId: 'org_id',
    ruleId: 'rule_id',
    ruleKind: 'rule_kind',
    trigger: 'trigger',
    thresholdValue: 'threshold_value',
    currentValue: 'current_value',
    band: 'band',
    firedAt: 'fired_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  gte: (a: unknown, b: unknown) => ({ gte: [a, b] }),
  desc: (a: unknown) => ({ desc: a }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}));

const { dbAdmin } = await import('../../lib/db.js');
const { create, getLatestByRuleId, countRecentByOrgId } = await import('./alertRuleFires.js');

const mockRow = {
  id: 1,
  orgId: 10,
  ruleId: 5,
  ruleKind: 'runway_runs_short' as const,
  trigger: 'cron',
  thresholdValue: { months: 3 },
  currentValue: 0.8,
  band: 3,
  firedAt: new Date('2026-07-17T06:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  selectResult = [];
  returningResult = [];
});

describe('create', () => {
  it('inserts a fire row and returns it', async () => {
    returningResult = [mockRow];

    const result = await create(
      {
        orgId: 10,
        ruleId: 5,
        ruleKind: 'runway_runs_short',
        trigger: 'cron',
        thresholdValue: { months: 3 },
        currentValue: 0.8,
        band: 3,
      },
      dbAdmin,
    );

    expect(result).toEqual(mockRow);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 10, ruleId: 5, band: 3, currentValue: 0.8 }),
    );
  });
});

describe('getLatestByRuleId', () => {
  it('returns the most recent fire ordered by firedAt desc', async () => {
    selectResult = [mockRow];

    const result = await getLatestByRuleId(5, dbAdmin);

    expect(result).toEqual(mockRow);
    expect(mockOrderBy).toHaveBeenCalled();
    expect(mockLimit).toHaveBeenCalledWith(1);
  });

  it('returns null when the rule has never fired', async () => {
    selectResult = [];

    const result = await getLatestByRuleId(5, dbAdmin);

    expect(result).toBeNull();
  });
});

describe('countRecentByOrgId', () => {
  it('returns the count of fires within the rolling 7-day window', async () => {
    selectResult = [{ value: 2 }];

    const result = await countRecentByOrgId(10, dbAdmin);

    expect(result).toBe(2);
    expect(mockWhere).toHaveBeenCalled();
  });

  it('returns 0 when the org has no recent fires', async () => {
    selectResult = [];

    const result = await countRecentByOrgId(10, dbAdmin);

    expect(result).toBe(0);
  });
});
