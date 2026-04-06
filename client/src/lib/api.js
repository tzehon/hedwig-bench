const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

export function startRun(config) {
  return request('/runs', { method: 'POST', body: JSON.stringify(config) });
}

export function listRuns() {
  return request('/runs');
}

export function getRun(id) {
  return request(`/runs/${id}`);
}

export function deleteRun(id) {
  return request(`/runs/${id}`, { method: 'DELETE' });
}

export function stopRun(id) {
  return request(`/runs/${id}/stop`, { method: 'POST' });
}

export function previewDoc(docSize, userPoolSize) {
  return request(`/runs/preview-doc?docSize=${docSize}&userPoolSize=${userPoolSize || 100000}`);
}

export function cleanup({ mongoUri, dbName, collectionName, clearHistory }) {
  return request('/runs/cleanup', {
    method: 'POST',
    body: JSON.stringify({ mongoUri, dbName, collectionName, clearHistory }),
  });
}

export async function clearAllRuns() {
  const runs = await listRuns();
  await Promise.all(runs.map((r) => deleteRun(r.id)));
  return { deleted: runs.length };
}

export function createWebSocket(runId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return new WebSocket(`${protocol}//${host}/ws/runs/${runId}`);
}
