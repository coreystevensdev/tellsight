import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelectFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockInsertValues = vi.fn();
const mockReturning = vi.fn();
const mockExecute = vi.fn().mockResolvedValue(undefined);
const mockTransaction = vi.fn();

// Separate spies for the object handed to dbAdmin.transaction's callback, a
// distinct object from dbAdmin itself, same as the real drizzle client. If
// createIfUnderQuota accidentally closed over dbAdmin instead of threading
// its tx parameter through, tests asserting against these would catch it.
const mockTxSelectFrom = vi.fn();
const mockTxWhere = vi.fn();
const mockTxInsertValues = vi.fn();
const mockTxReturning = vi.fn();
const mockTxExecute = vi.fn().mockResolvedValue(undefined);

let selectResult: unknown[] = [];
let returningResult: unknown[] = [];

function makeClient(spies: {
  selectFrom: (...args: unknown[]) => void;
  where: (...args: unknown[]) => void;
  insertValues: (...args: unknown[]) => void;
  returning: () => void;
  execute: (...args: unknown[]) => unknown;
}) {
  return {
    select: () => ({
      from: (...f: unknown[]) => {
        spies.selectFrom(...f);
        return {
          where: (...w: unknown[]) => {
            spies.where(...w);
            return {
              then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
                Promise.resolve(selectResult).then(resolve, reject),
              orderBy: (...o: unknown[]) => {
                mockOrderBy(...o);
                return {
                  limit: (...l: unknown[]) => {
                    mockLimit(...l);
                    return {
                      then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
                        Promise.resolve(selectResult).then(resolve, reject),
                    };
                  },
                };
              },
            };
          },
        };
      },
    }),
    insert: () => ({
      values: (...args: unknown[]) => {
        spies.insertValues(...args);
        return {
          returning: () => {
            spies.returning();
            return Promise.resolve(returningResult);
          },
        };
      },
    }),
    execute: (...args: unknown[]) => spies.execute(...args),
  };
}

vi.mock('../../lib/db.js', () => {
  const txClient = makeClient({
    selectFrom: mockTxSelectFrom,
    where: mockTxWhere,
    insertValues: mockTxInsertValues,
    returning: mockTxReturning,
    execute: mockTxExecute,
  });
  const client = {
    ...makeClient({
      selectFrom: mockSelectFrom,
      where: mockWhere,
      insertValues: mockInsertValues,
      returning: mockReturning,
      execute: mockExecute,
    }),
    transaction: (cb: (tx: unknown) => unknown) => {
      mockTransaction(cb);
      return cb(txClient);
    },
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
const { create, getLatestByRuleId, countRecentByOrgId, createIfUnderQuota } =
  await import('./alertRuleFires.js');

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

describe('createIfUnderQuota', () => {
  const input = {
    orgId: 10,
    ruleId: 5,
    ruleKind: 'runway_runs_short' as const,
    trigger: 'cron',
    thresholdValue: { months: 3 },
    currentValue: 0.8,
    band: 3,
  };

  it('inserts a fire row when the org is under quota, via the tx passed into the transaction callback', async () => {
    selectResult = [{ value: 2 }];
    returningResult = [mockRow];

    const result = await createIfUnderQuota(input, 3, dbAdmin);

    expect(result).toEqual(mockRow);
    expect(mockTransaction).toHaveBeenCalled();
    expect(mockTxExecute).toHaveBeenCalled();
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 10, ruleId: 5, band: 3 }),
    );
    // Proves the insert went through the tx object handed to the transaction
    // callback, not the outer dbAdmin client.
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns null without inserting when the org is at quota', async () => {
    selectResult = [{ value: 3 }];

    const result = await createIfUnderQuota(input, 3, dbAdmin);

    expect(result).toBeNull();
    expect(mockTxInsertValues).not.toHaveBeenCalled();
  });

  it('reflects an updated count on a later call in the same job, once an earlier insert has landed', async () => {
    selectResult = [{ value: 2 }];
    returningResult = [mockRow];

    const first = await createIfUnderQuota(input, 3, dbAdmin);
    expect(first).toEqual(mockRow);

    // Simulates the DB-visible effect of the first insert within this job's
    // rule loop: the org's recent-fire count is now at quota.
    selectResult = [{ value: 3 }];

    const second = await createIfUnderQuota(input, 3, dbAdmin);
    expect(second).toBeNull();
  });

  it('runs directly against an already-open transaction client instead of opening a new one', async () => {
    const txSelectWhere = vi.fn();
    const txInsertValues = vi.fn();
    const txExecute = vi.fn().mockResolvedValue(undefined);
    const openTx = {
      select: () => ({
        from: () => ({
          where: (...w: unknown[]) => {
            txSelectWhere(...w);
            return Promise.resolve([{ value: 1 }]);
          },
        }),
      }),
      insert: () => ({
        values: (...args: unknown[]) => {
          txInsertValues(...args);
          return { returning: () => Promise.resolve([mockRow]) };
        },
      }),
      execute: (...args: unknown[]) => txExecute(...args),
    };

    const result = await createIfUnderQuota(input, 3, openTx as never);

    expect(result).toEqual(mockRow);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(txExecute).toHaveBeenCalled();
    expect(txSelectWhere).toHaveBeenCalled();
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 10, ruleId: 5, band: 3 }),
    );
  });
});
