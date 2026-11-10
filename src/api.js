async function call(path, init) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  settings: () => call('/api/settings'),
  saveSettings: (patch) => call('/api/settings', json('PUT', patch)),
  deepseekModels: () => call('/api/deepseek/models'),
  comfyStatus: () => call('/api/comfy/status'),
  workflows: (refresh) => call(`/api/comfy/workflows${refresh ? '?refresh=1' : ''}`),
  capabilities: (project) => call(`/api/capabilities${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  setProjectModel: (project, category, id) => call(`/api/projects/${project}`, json('PATCH', { model: { category, id } })),
  setDefaultCapability: (category, id) => call('/api/capabilities/default', json('PUT', { category, id })),
  addCapabilityModel: (body) => call('/api/capabilities/models', json('POST', body)),
  removeCapabilityModel: (id) => call(`/api/capabilities/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  projects: () => call('/api/projects'),
  createProject: () => call('/api/projects', json('POST', {})),
  project: (id) => call(`/api/projects/${id}`),
  renameProject: (id, title) => call(`/api/projects/${id}`, json('PATCH', { title })),
  deleteProject: (id) => call(`/api/projects/${id}`, { method: 'DELETE' }),
  send: (id, payload) => call(`/api/projects/${id}/messages`, json('POST', payload)),
  stop: (id) => call(`/api/projects/${id}/stop`, { method: 'POST' }),
  upload: (id, file, position) =>
    call(`/api/projects/${id}/upload`, {
      method: 'POST',
      headers: {
        'X-Filename': encodeURIComponent(file.name),
        'Content-Type': 'application/octet-stream',
        ...(position ? { 'X-Position': JSON.stringify(position) } : {}),
      },
      body: file,
    }),
  updateAsset: (id, assetId, patch) => call(`/api/projects/${id}/assets/${assetId}`, json('PATCH', patch)),
  deleteAsset: (id, assetId) => call(`/api/projects/${id}/assets/${assetId}`, { method: 'DELETE' }),
  revealFile: (f) => call('/api/comfy/reveal', json('POST', { filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' })),
  restoreAssets: (id, assets, edges) => call(`/api/projects/${id}/assets/restore`, json('POST', { assets, edges })),
};

export const fileUrl = (f) =>
  f ? `/api/comfy/view?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' })}` : '';

/** Baixa o arquivo (o servidor manda como anexo; no app de desktop abre "Salvar como"). */
export function downloadFile(f) {
  if (!f) return;
  const a = document.createElement('a');
  a.href = `${fileUrl(f)}&download=1`;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
