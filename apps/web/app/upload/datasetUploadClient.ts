import { attemptRefresh } from '@/lib/api-client';

export interface DatasetPreviewResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

function sendDatasetPreview(
  file: File,
  onProgress: (percent: number) => void,
): Promise<DatasetPreviewResponse> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    xhr.addEventListener('load', () => {
      try {
        const data = JSON.parse(xhr.responseText);
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
      } catch {
        reject(new Error('Failed to parse server response'));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    xhr.open('POST', '/api/datasets');
    xhr.withCredentials = true;
    xhr.send(formData);
  });
}

export async function uploadDatasetPreview(
  file: File,
  onProgress: (percent: number) => void,
): Promise<DatasetPreviewResponse> {
  let response = await sendDatasetPreview(file, onProgress);

  if (response.status === 401 && (await attemptRefresh())) {
    response = await sendDatasetPreview(file, onProgress);
  }

  return response;
}

function sendDatasetConfirmation(file: File, previewToken: string): Promise<Response> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('previewToken', previewToken);
  return fetch('/api/datasets/confirm', {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });
}

export async function confirmDatasetUpload(file: File, previewToken: string): Promise<Response> {
  let response = await sendDatasetConfirmation(file, previewToken);

  if (response.status === 401 && (await attemptRefresh())) {
    response = await sendDatasetConfirmation(file, previewToken);
  }

  return response;
}
