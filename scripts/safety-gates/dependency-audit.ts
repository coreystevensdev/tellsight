export interface Advisory {
  module_name: string;
  severity: string;
  title: string;
  patched_versions?: string;
  findings?: Array<{ paths?: string[] }>;
}

export interface Acknowledgement {
  module: string;
  reviewed: string;
  reason: string;
  revisit: string;
}

export interface AuditClassification {
  blocking: Advisory[];
  unacknowledged: Advisory[];
  covered: Acknowledgement[];
  obsolete: Acknowledgement[];
}

const BLOCKING = new Set(['high', 'critical']);

export function parseAuditReport(raw: string): Advisory[] {
  const parsed = JSON.parse(raw) as { advisories?: Record<string, Advisory> };
  return Object.values(parsed.advisories ?? {});
}

export function classifyAudit(
  advisories: Advisory[],
  acknowledgements: Acknowledgement[],
): AuditClassification {
  const blocking = advisories.filter((advisory) => BLOCKING.has(advisory.severity));
  const acknowledged = new Map(acknowledgements.map((entry) => [entry.module, entry]));
  const reported = new Set(blocking.map((advisory) => advisory.module_name));

  return {
    blocking,
    unacknowledged: blocking.filter((advisory) => !acknowledged.has(advisory.module_name)),
    covered: [...reported].flatMap((module) => {
      const acknowledgement = acknowledged.get(module);
      return acknowledgement ? [acknowledgement] : [];
    }),
    obsolete: acknowledgements.filter((entry) => !reported.has(entry.module)),
  };
}
