import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import multer from 'multer';
import { MAX_FILE_SIZE, CSV_MAX_ROWS, ANALYTICS_EVENTS } from 'shared/constants';
import type { AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { ValidationError } from '../lib/appError.js';
import { csvAdapter } from '../services/dataIngestion/index.js';
import { normalizeRows } from '../services/dataIngestion/normalizer.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { logger } from '../lib/logger.js';
import type { PreviewData, ParsedRow } from '../services/adapters/index.js';
import { normalizeHeader } from '../services/dataIngestion/index.js';
import { datasetsQueries, orgsQueries } from '../db/queries/index.js';
import { withRlsContext } from '../lib/rls.js';
import { env } from '../config.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const csvTypes = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];
    if (csvTypes.includes(file.mimetype) || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new ValidationError(`We expected a .csv file, but received a ${file.mimetype} file.`));
    }
  },
});

function handleMulterError(err: unknown, _req: Request, _res: Response, next: NextFunction) {
  if (err && typeof err === 'object' && 'code' in err) {
    const multerErr = err as { code: string; message: string };
    if (multerErr.code === 'LIMIT_FILE_SIZE') {
      return next(new ValidationError('File size exceeds 10MB limit. Try splitting your data into smaller files.'));
    }
  }
  next(err);
}

const DATE_SHAPE = /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/;

function inferColumnType(value: string): 'date' | 'number' | 'text' {
  const trimmed = value.trim().replace(/,/g, '');
  if (!isNaN(Number(trimmed)) && trimmed !== '') return 'number';
  if (DATE_SHAPE.test(trimmed) && !isNaN(new Date(trimmed).getTime())) return 'date';
  return 'text';
}

function buildColumnTypes(rows: Record<string, string>[], headers: string[]): Record<string, 'date' | 'number' | 'text'> {
  const types: Record<string, 'date' | 'number' | 'text'> = {};
  const sample = rows.slice(0, 5);
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const votes = sample
      .map((r) => r[header]?.trim())
      .filter(Boolean)
      .map((v) => inferColumnType(v!));

    if (votes.length === 0) {
      types[normalized] = 'text';
      continue;
    }

    // majority wins
    const counts: Record<string, number> = {};
    for (const v of votes) counts[v] = (counts[v] ?? 0) + 1;
    types[normalized] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0] as 'date' | 'number' | 'text';
  }
  return types;
}

/** Remap original-cased row keys to normalized (lowercase) keys for the preview response */
function normalizeSampleRows(rows: ParsedRow[], rawHeaders: string[]): Record<string, string>[] {
  return rows.map((row) => {
    const out: Record<string, string> = {};
    for (const key of rawHeaders) {
      out[normalizeHeader(key)] = row[key] ?? '';
    }
    return out;
  });
}

// Known gap: no replay protection. Same token can confirm duplicates within the TTL window.
// Acceptable for MVP — duplicate uploads are user-visible and self-correcting. To harden:
// either a UNIQUE(org_id, file_hash) constraint or Redis-based token consumption.
const PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1000;

function computeFileHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function signPreviewToken(hash: string, orgId: number, secret: string): string {
  const iat = Date.now();
  const payload = `${hash}:${orgId}:${iat}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ hash, orgId, iat, sig })).toString('base64url');
}

function verifyPreviewToken(token: string, buffer: Buffer, orgId: number, secret: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());

    if (!decoded || typeof decoded.hash !== 'string' || typeof decoded.orgId !== 'number' ||
        typeof decoded.iat !== 'number' || typeof decoded.sig !== 'string') {
      return false;
    }

    const { hash, orgId: tokenOrg, iat, sig } = decoded;

    // cheap rejections first — avoid HMAC + SHA-256 for expired or wrong-org tokens
    if (tokenOrg !== orgId) return false;
    if (Date.now() - iat > PREVIEW_TOKEN_TTL_MS) return false;

    const expected = createHmac('sha256', secret)
      .update(`${hash}:${tokenOrg}:${iat}`)
      .digest('hex');

    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return false;

    // file hash is the most expensive check — SHA-256 over up to 10MB
    const actualHash = Buffer.from(computeFileHash(buffer), 'hex');
    const expectedHash = Buffer.from(hash, 'hex');
    if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) return false;

    return true;
  } catch {
    return false;
  }
}

export const datasetsRouter = Router();

datasetsRouter.post(
  '/',
  upload.single('file'),
  handleMulterError,
  async (req: Request, res: Response) => {
    const { user } = req as AuthenticatedRequest;
    const orgId = user.org_id;
    const userId = parseInt(user.sub, 10);

    if (!req.file) {
      throw new ValidationError('No file provided. Select a CSV file to upload.');
    }

    const fileName = req.file.originalname;
    logger.info({ orgId, userId, fileName, size: req.file.size }, 'CSV upload received');

    const parseResult = csvAdapter.parse(req.file.buffer);

    if (parseResult.rowCount > CSV_MAX_ROWS) {
      throw new ValidationError(
        `File has ${parseResult.rowCount.toLocaleString()} rows, but the maximum is ${CSV_MAX_ROWS.toLocaleString()}. Split your data into smaller files.`,
        { fileName, rowCount: parseResult.rowCount, maxRows: CSV_MAX_ROWS },
      );
    }

    if (parseResult.rows.length === 0 && parseResult.warnings.length > 0) {
      throw new ValidationError(parseResult.warnings[0] ?? 'Validation failed', { fileName });
    }

    const headerValidation = csvAdapter.validate(parseResult.headers);
    if (!headerValidation.valid) {
      throw new ValidationError('CSV validation failed', {
        errors: headerValidation.errors,
        fileName,
      });
    }

    if (parseResult.rows.length === 0 && parseResult.rowCount > 0) {
      throw new ValidationError(
        'More than half the rows had validation errors. Check your data format and try again.',
        { fileName },
      );
    }

    const sampleRows = normalizeSampleRows(parseResult.rows.slice(0, 5), parseResult.headers);
    const columnTypes = buildColumnTypes(parseResult.rows, parseResult.headers);

    const fileHash = computeFileHash(req.file.buffer);
    const previewToken = signPreviewToken(fileHash, orgId, env.JWT_SECRET);

    const preview: PreviewData = {
      headers: parseResult.headers.map(normalizeHeader),
      sampleRows,
      rowCount: parseResult.rowCount,
      validRowCount: parseResult.rows.length,
      skippedRowCount: parseResult.rowCount - parseResult.rows.length,
      columnTypes,
      warnings: parseResult.warnings,
      fileName,
      previewToken,
    };

    trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_UPLOADED, {
      rowCount: parseResult.rowCount,
      fileName,
    });

    logger.info(
      { orgId, fileName, rowCount: parseResult.rowCount, validRows: parseResult.rows.length },
      'CSV validated',
    );

    res.json({ data: preview });
  },
);

datasetsRouter.post(
  '/confirm',
  upload.single('file'),
  handleMulterError,
  async (req: Request, res: Response) => {
    const { user } = req as AuthenticatedRequest;
    const orgId = user.org_id;
    const userId = parseInt(user.sub, 10);

    if (!req.file) {
      throw new ValidationError('No file provided. Select a CSV file to upload.');
    }

    // TOCTOU gate — reject if the file changed since preview
    const token = req.body?.previewToken;
    if (!token || typeof token !== 'string') {
      throw new ValidationError('Missing preview token. Preview your file before confirming.');
    }

    if (!verifyPreviewToken(token, req.file.buffer, orgId, env.JWT_SECRET)) {
      throw new ValidationError('File has changed since preview. Please re-upload and preview again.');
    }

    const fileName = req.file.originalname;
    logger.info({ orgId, userId, fileName }, 'Dataset confirm received');

    const parseResult = csvAdapter.parse(req.file.buffer);

    const headerValidation = csvAdapter.validate(parseResult.headers);
    if (!headerValidation.valid) {
      throw new ValidationError('CSV validation failed', {
        errors: headerValidation.errors,
        fileName,
      });
    }

    if (parseResult.rows.length === 0) {
      throw new ValidationError('No valid rows to import. Check your data and try again.', { fileName });
    }

    const normalizedRows = normalizeRows(parseResult.rows, parseResult.headers);
    const result = await withRlsContext(orgId, user.isAdmin, async (tx) => {
      const persisted = await datasetsQueries.persistUpload(orgId, userId, fileName, normalizedRows, tx);
      await orgsQueries.setActiveDataset(orgId, persisted.datasetId, tx);
      return persisted;
    });

    trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_CONFIRMED, {
      datasetId: result.datasetId,
      rowCount: result.rowCount,
    });

    logger.info(
      { orgId, userId, datasetId: result.datasetId, rowCount: result.rowCount },
      'Dataset confirmed and persisted',
    );

    res.json({ data: result });
  },
);
