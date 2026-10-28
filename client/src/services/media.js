import { apiRequest } from './api';

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(new Error('Falha ao ler arquivo'));
  reader.readAsDataURL(file);
});

export const listMediaAssets = async () => {
  const res = await apiRequest('/media/assets?limit=500');
  if (!res || !res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.items) ? data.items : [];
};

export const uploadMediaAsset = async (file) => {
  const dataUrl = await fileToDataUrl(file);
  const res = await apiRequest('/media/assets', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type,
      dataUrl
    })
  });
  if (!res || !res.ok) {
    const error = res ? await res.json().catch(() => ({})) : {};
    throw new Error(error?.error || 'Falha no upload');
  }
  return res.json();
};
