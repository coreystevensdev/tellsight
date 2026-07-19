import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockSelectFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockInsertValues = vi.fn();
const mockUpdateSet = vi.fn();
const mockReturning = vi.fn();

let selectResult: unknown[] = [];
let returningResult: unknown[] = [];

function thenable(getResult: () => unknown[]) {
  return {
    then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(getResult()).then(resolve, reject),
  };
}

let returningError: unknown = null;

function resolveReturning() {
  mockReturning();
  if (returningError) return Promise.reject(returningError);
  return Promise.resolve(returningResult);
}

vi.mock('../../lib/db.js', () => {
  const buildSelect = () => ({
    from: (...args: unknown[]) => {
      mockSelectFrom(...args);
      return {
        where: (...w: unknown[]) => {
          mockWhere(...w);
          return {
            orderBy: (...o: unknown[]) => {
              mockOrderBy(...o);
              return thenable(() => selectResult);
            },
            limit: (...l: unknown[]) => {
              mockLimit(...l);
              return thenable(() => selectResult);
            },
            then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
              Promise.resolve(selectResult).then(resolve, reject),
          };
        },
      };
    },
  });

  const buildInsert = () => ({
    values: (...args: unknown[]) => {
      mockInsertValues(...args);
      return { returning: resolveReturning };
    },
  });

  const buildUpdate = () => ({
    set: (...args: unknown[]) => {
      mockUpdateSet(...args);
      return {
        where: (...w: unknown[]) => {
          mockWhere(...w);
          return { returning: resolveReturning };
        },
      };
    },
  });

  const client = { select: buildSelect, insert: buildInsert, update: buildUpdate };
  return { db: client, dbAdmin: client };
});

// getByOrgId/getById render their captured .where() condition through the
// real drizzle-orm + schema (no mock for either), same technique as
// alertRuleMuteExclusion.test.ts, so PgDialect can turn it back into SQL text.
const dialect = new PgDialect();

const { db, dbAdmin } = await import('../../lib/db.js');
const { ConflictError } = await import('../../lib/appError.js');
const {
  getByOrgId,
  getById,
  create,
  update,
  softDelete,
  muteViaToken,
  unmuteViaToken,
  getEnabledByOrgIdsForEvaluation,
} = await import('./alertRules.js');

const mockRow = {
  id: 1,
  orgId: 10,
  createdByUserId: 5,
  kind: 'runway_runs_short' as const,
  threshold: { months: 3 },
  enabled: true,
  muteUntil: null,
  deletedAt: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  selectResult = [];
  returningResult = [];
  returningError = null;
});

describe('getByOrgId', () => {
  it('returns non-deleted rows ordered newest first', async () => {
    selectResult = [mockRow];

    const result = await getByOrgId(10, db);

    expect(result).toEqual([mockRow]);
    expect(mockOrderBy).toHaveBeenCalled();

    const condition = mockWhere.mock.calls[0]![0];
    const { sql, params } = dialect.sqlToQuery(condition as never);
    expect(sql).toContain('"alert_rules"."org_id" = $1 and "alert_rules"."deleted_at" is null');
    expect(params).toEqual([10]);
  });

  it('returns empty array when the org has no rules', async () => {
    selectResult = [];

    const result = await getByOrgId(10, db);

    expect(result).toEqual([]);
  });
});

describe('getById', () => {
  it('returns the row when it belongs to the org', async () => {
    selectResult = [mockRow];

    const result = await getById(10, 1, db);

    expect(result).toEqual(mockRow);
    expect(mockLimit).toHaveBeenCalledWith(1);

    const condition = mockWhere.mock.calls[0]![0];
    const { sql, params } = dialect.sqlToQuery(condition as never);
    expect(sql).toContain(
      '"alert_rules"."id" = $1 and "alert_rules"."org_id" = $2 and "alert_rules"."deleted_at" is null',
    );
    // Positional, not arrayContaining: a bug that swaps which column gets which
    // value (e.g. id filtered against orgId) renders identical SQL text and
    // would slip past a set-membership check.
    expect(params).toEqual([1, 10]);
  });

  it('returns null when scoped to a different org (RLS + explicit filter)', async () => {
    selectResult = [];

    const result = await getById(999, 1, db);

    expect(result).toBeNull();
  });
});

describe('create', () => {
  it('inserts with enabled defaulting to true and muteUntil null when absent', async () => {
    returningResult = [mockRow];

    const result = await create(10, 5, { kind: 'runway_runs_short', threshold: { months: 3 } }, db);

    expect(result).toEqual(mockRow);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 10,
        createdByUserId: 5,
        kind: 'runway_runs_short',
        threshold: { months: 3 },
        enabled: true,
        muteUntil: null,
      }),
    );
  });

  it('converts a supplied muteUntil string to a Date', async () => {
    returningResult = [mockRow];
    const muteUntil = '2026-08-01T00:00:00.000Z';

    await create(10, 5, {
      kind: 'margin_drops',
      threshold: { percent: 5 },
      muteUntil,
    }, db);

    const inserted = mockInsertValues.mock.calls[0]![0] as { muteUntil: Date };
    expect(inserted.muteUntil).toEqual(new Date(muteUntil));
  });

  it('throws ConflictError when the org already has an active rule of that kind', async () => {
    returningError = { code: '23505', constraint_name: 'idx_alert_rules_org_kind_active' };

    await expect(
      create(10, 5, { kind: 'runway_runs_short', threshold: { months: 3 } }, db),
    ).rejects.toThrow(ConflictError);
  });

  it('rethrows a non-unique-violation error unchanged', async () => {
    returningError = new Error('connection reset');

    await expect(
      create(10, 5, { kind: 'runway_runs_short', threshold: { months: 3 } }, db),
    ).rejects.toThrow('connection reset');
  });
});

describe('update', () => {
  it('always replaces kind and threshold together', async () => {
    returningResult = [{ ...mockRow, kind: 'margin_drops', threshold: { percent: 10 } }];

    const result = await update(10, 1, { kind: 'margin_drops', threshold: { percent: 10 } }, db);

    expect(result?.kind).toBe('margin_drops');
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'margin_drops', threshold: { percent: 10 } }),
    );
  });

  it('leaves enabled and muteUntil out of the SET clause when omitted, so a threshold-only edit cannot re-enable a disabled rule or clear an active mute', async () => {
    returningResult = [{ ...mockRow, kind: 'margin_drops', threshold: { percent: 10 } }];

    await update(10, 1, { kind: 'margin_drops', threshold: { percent: 10 } }, db);

    const setArg = mockUpdateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('enabled');
    expect(setArg).not.toHaveProperty('muteUntil');
  });

  it('sets enabled to an explicit false rather than defaulting it', async () => {
    returningResult = [{ ...mockRow, enabled: false }];

    await update(10, 1, { kind: 'runway_runs_short', threshold: { months: 3 }, enabled: false }, db);

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('converts an explicit muteUntil string to a Date', async () => {
    returningResult = [{ ...mockRow }];
    const muteUntil = '2026-08-01T00:00:00.000Z';

    await update(10, 1, { kind: 'runway_runs_short', threshold: { months: 3 }, muteUntil }, db);

    const setArg = mockUpdateSet.mock.calls[0]![0] as { muteUntil: Date };
    expect(setArg.muteUntil).toEqual(new Date(muteUntil));
  });

  it('clears an explicit null muteUntil', async () => {
    returningResult = [{ ...mockRow }];

    await update(10, 1, { kind: 'runway_runs_short', threshold: { months: 3 }, muteUntil: null }, db);

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ muteUntil: null }));
  });

  it('returns null when the rule belongs to a different org (treated as not-found)', async () => {
    returningResult = [];

    const result = await update(999, 1, { kind: 'margin_drops', threshold: { percent: 10 } }, db);

    expect(result).toBeNull();
  });

  it('throws ConflictError when the new kind collides with another active rule', async () => {
    returningError = { code: '23505', constraint_name: 'idx_alert_rules_org_kind_active' };

    await expect(
      update(10, 1, { kind: 'margin_drops', threshold: { percent: 10 } }, db),
    ).rejects.toThrow(ConflictError);
  });
});

describe('softDelete', () => {
  it('sets deletedAt instead of removing the row', async () => {
    returningResult = [{ ...mockRow, deletedAt: new Date() }];

    const result = await softDelete(10, 1, db);

    expect(result?.deletedAt).toBeInstanceOf(Date);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it('clears muteUntil so a lapsed mute window cannot fail the mute_until CHECK constraint on this UPDATE', async () => {
    returningResult = [{ ...mockRow, deletedAt: new Date(), muteUntil: null }];

    await softDelete(10, 1, db);

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ muteUntil: null }));
  });

  it('returns null when already deleted or not found', async () => {
    returningResult = [];

    const result = await softDelete(10, 1, db);

    expect(result).toBeNull();
  });
});

describe('muteViaToken', () => {
  it('sets muteUntil roughly 30 days out, unscoped by org', async () => {
    const before = Date.now();
    returningResult = [{ ...mockRow, muteUntil: new Date(before + 30 * 86_400_000) }];

    const result = await muteViaToken(1, dbAdmin);

    expect(result?.muteUntil).toBeInstanceOf(Date);
    const setArg = mockUpdateSet.mock.calls[0]![0] as { muteUntil: Date };
    const daysOut = (setArg.muteUntil.getTime() - before) / 86_400_000;
    expect(daysOut).toBeGreaterThan(29.9);
    expect(daysOut).toBeLessThan(30.1);
  });

  it('returns null for a soft-deleted or nonexistent rule', async () => {
    returningResult = [];

    const result = await muteViaToken(999, dbAdmin);

    expect(result).toBeNull();
  });
});

describe('unmuteViaToken', () => {
  it('clears muteUntil, unscoped by org', async () => {
    returningResult = [{ ...mockRow, muteUntil: null }];

    const result = await unmuteViaToken(1, dbAdmin);

    expect(result?.muteUntil).toBeNull();
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ muteUntil: null }));
  });

  it('returns null for a soft-deleted or nonexistent rule', async () => {
    returningResult = [];

    const result = await unmuteViaToken(999, dbAdmin);

    expect(result).toBeNull();
  });
});

describe('getEnabledByOrgIdsForEvaluation', () => {
  it('short-circuits without querying when orgIds is empty', async () => {
    const result = await getEnabledByOrgIdsForEvaluation([], dbAdmin);

    expect(result).toEqual([]);
    expect(mockSelectFrom).not.toHaveBeenCalled();
  });

  it('returns enabled, non-deleted, non-muted rows across orgs', async () => {
    selectResult = [mockRow, { ...mockRow, id: 2, orgId: 20 }];

    const result = await getEnabledByOrgIdsForEvaluation([10, 20], dbAdmin);

    expect(result).toHaveLength(2);
    expect(mockWhere).toHaveBeenCalled();
  });
});
