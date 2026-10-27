'use client';

import { useSyncExternalStore, type RefObject } from 'react';
import { AlertCircle, CheckCircle2, Upload } from 'lucide-react';
import type { ColumnValidationError } from 'shared/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';

export interface UploadError {
  message: string;
  errors?: ColumnValidationError[];
  fileName?: string;
}

interface UploadStatusContentProps {
  state: 'default' | 'dragHover' | 'processing' | 'preview' | 'error';
  uploadProgress: number;
  lastFile: File | null;
}

const subscribeToTouchCapability = () => () => {};
const getTouchCapability = () => 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const getServerTouchCapability = () => false;

function useIsTouchDevice() {
  return useSyncExternalStore(
    subscribeToTouchCapability,
    getTouchCapability,
    getServerTouchCapability,
  );
}

export function UploadStatusContent({
  state,
  uploadProgress,
  lastFile,
}: UploadStatusContentProps) {
  const isTouchDevice = useIsTouchDevice();

  if (state === 'default') {
    return (
      <div className="text-center">
        <Upload className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
        <p className="text-base font-medium">
          {isTouchDevice ? 'Tap to select your CSV file' : 'Drag your CSV here or click to browse'}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">Accepted: .csv up to 10MB</p>
      </div>
    );
  }

  if (state === 'dragHover') {
    return (
      <div className="text-center">
        <Upload className="mx-auto mb-3 h-12 w-12 text-primary" />
        <p className="text-lg font-medium text-primary">Drop to upload</p>
      </div>
    );
  }

  if (state === 'processing') {
    return (
      <div className="w-full max-w-xs text-center">
        <Upload className="mx-auto mb-3 h-10 w-10 animate-pulse text-muted-foreground" />
        <p className="mb-4 text-sm font-medium">Validating your data...</p>
        <Progress
          value={uploadProgress}
          indeterminate={uploadProgress >= 100}
          className="mx-auto"
        />
        {uploadProgress < 100 && (
          <p className="mt-2 text-xs text-muted-foreground">{uploadProgress}% uploaded</p>
        )}
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="text-center">
        <AlertCircle className="mx-auto mb-3 h-10 w-10 text-destructive" />
        <p className="text-sm font-medium text-destructive">Validation failed</p>
        {lastFile && (
          <p className="mt-1 text-xs text-muted-foreground">
            Last attempt: {lastFile.name}
          </p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Drop a corrected file or click to select
        </p>
      </div>
    );
  }

  return null;
}

export function UploadErrorAlert({
  error,
  alertRef,
}: {
  error: UploadError;
  alertRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={alertRef} tabIndex={-1} aria-live="assertive">
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{error.message}</AlertTitle>
        {error.errors && error.errors.length > 0 && (
          <AlertDescription>
            <ul className="mt-2 space-y-1">
              {error.errors.map((validationError, index) => (
                <li key={index} className="text-sm">
                  {validationError.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        )}
        <AlertDescription className="mt-3">
          <a
            href="/templates/sample-data.csv"
            download="sample-data.csv"
            className="font-medium underline underline-offset-4"
            onClick={(event) => event.stopPropagation()}
          >
            Download sample template
          </a>
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function UploadSuccess({ rowCount, countdown }: { rowCount: number; countdown: number }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center rounded-lg border-2 border-success/50 bg-success/10 p-8 text-center">
      <CheckCircle2 className="mb-3 h-12 w-12 text-success" />
      <p className="text-lg font-medium text-foreground">
        {rowCount.toLocaleString()} transactions uploaded!
      </p>
      <p className="mt-1 text-sm text-success">
        Redirecting to dashboard in {countdown}...
      </p>
    </div>
  );
}
