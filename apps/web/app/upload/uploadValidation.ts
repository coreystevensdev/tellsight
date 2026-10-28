import { ACCEPTED_FILE_TYPES, MAX_FILE_SIZE } from 'shared/constants';

export function validateUploadFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return 'File size exceeds 10MB limit. Try splitting your data into smaller files.';
  }

  const hasValidExtension = file.name.toLowerCase().endsWith('.csv');
  const hasValidMimeType = (ACCEPTED_FILE_TYPES as readonly string[]).includes(file.type);
  if (!hasValidExtension && !hasValidMimeType) {
    return `We expected a .csv file, but received a ${file.type || 'unknown'} file type.`;
  }

  if (file.size === 0) {
    return 'This file appears to be empty. Download our sample template to see the expected format.';
  }

  return null;
}
