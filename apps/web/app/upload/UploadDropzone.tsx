'use client';

import { cn } from '@/lib/utils';
import { CsvPreview } from './CsvPreview';
import { useDatasetUploadWorkflow } from './useDatasetUploadWorkflow';
import { useUploadDropzoneInteractions } from './useUploadDropzoneInteractions';
import {
  UploadErrorAlert,
  UploadStatusContent,
  UploadSuccess,
} from './UploadDropzoneFeedback';

export function UploadDropzone() {
  const upload = useDatasetUploadWorkflow();

  const {
    fileInputRef,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleInputChange,
    handleKeyDown,
    openFilePicker,
  } = useUploadDropzoneInteractions(upload.selectFile, upload.setState);

  // Preview and success states render outside the dropzone
  if (upload.state === 'preview' && upload.previewData) {
    return (
      <div className="space-y-4">
        <CsvPreview
          previewData={upload.previewData}
          onConfirm={upload.confirmUpload}
          onCancel={upload.cancelPreview}
          isConfirming={upload.isConfirming}
        />
      </div>
    );
  }

  if (upload.state === 'success') {
    return <UploadSuccess rowCount={upload.confirmedRowCount} countdown={upload.countdown} />;
  }

  return (
    <div className="space-y-4">
      {/* Outside the role="button" element on purpose. Nested inside it, axe
          reports nested-interactive: a negative tabindex and aria-hidden do not
          stop assistive tech reaching a control inside an interactive parent.
          Nothing else changes, this is only a handle for
          fileInputRef.current.click(). */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleInputChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />
      <div
        role="button"
        tabIndex={0}
        // Named by its content, not an aria-label. The visible text changes with
        // state and with touch, so a fixed label drifts out of it and trips
        // label-content-name-mismatch (WCAG 2.5.3 Label in Name). Content also
        // carries the 10MB limit, which the old label hid from a screen reader.
        onClick={openFilePicker}
        onKeyDown={handleKeyDown}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'relative flex min-h-[240px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          upload.state === 'default' && 'border-border hover:border-muted-foreground/50 hover:bg-muted/50',
          upload.state === 'dragHover' && 'border-primary bg-accent',
          upload.state === 'processing' && 'border-primary/50 bg-muted/30',
          upload.state === 'error' && 'border-destructive bg-destructive/5',
        )}
      >

        <UploadStatusContent
          state={upload.state}
          uploadProgress={upload.uploadProgress}
          lastFile={upload.lastFile}
        />
      </div>

      {/* A sibling of the dropzone, not a child. Inside it this was a link
          nested in a role="button", which axe reports as nested-interactive and
          which leaves a keyboard user with two controls in one stop. The
          stopPropagation handlers it used to carry only ever fixed the mouse
          case. */}
      {upload.state === 'default' && (
        <a
          href="/templates/sample-data.csv"
          download="sample-data.csv"
          className="inline-block text-sm text-primary underline underline-offset-4"
        >
          Download sample template
        </a>
      )}

      {upload.state === 'error' && upload.error && (
        <UploadErrorAlert error={upload.error} alertRef={upload.alertRef} />
      )}
    </div>
  );
}
