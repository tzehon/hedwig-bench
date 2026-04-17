import { useState, useEffect, useRef, useCallback } from 'react';
import { startLoaderJob, stopLoaderJob, previewLoaderDoc, createLoaderWebSocket } from '../lib/api';

// ---------------------------------------------------------------------------
// Reusable UI helpers (same patterns as ConfigPage)
// ---------------------------------------------------------------------------
function Section({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-3 text-left text-sm font-semibold text-gray-100 hover:bg-gray-700/50 transition-colors"
      >
        {title}
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 pb-5 pt-2 space-y-4">{children}</div>}
    </div>
  );
}

function Label({ htmlFor, children }) {
  return <label htmlFor={htmlFor} className="block text-sm text-gray-400 mb-1">{children}</label>;
}

function TextInput({ id, value, onChange, placeholder, type = 'text', ...rest }) {
  return (
    <input
      id={id} type={type} value={value} onChange={onChange} placeholder={placeholder}
      className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
      {...rest}
    />
  );
}

function RangeSlider({ id, value, onChange, min, max, step = 1, label, unit = '' }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-sm font-mono text-emerald-300">{Number(value).toLocaleString()}{unit}</span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={onChange} className="w-full accent-emerald-500" />
      <div className="flex justify-between text-xs text-gray-500 mt-0.5">
        <span>{Number(min).toLocaleString()}{unit}</span>
        <span>{Number(max).toLocaleString()}{unit}</span>
      </div>
    </div>
  );
}

function EyeIcon({ open }) {
  if (open) {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.97 9.97 0 012.31-3.775M6.938 6.938A9.966 9.966 0 0112 5c4.478 0 8.268 2.943 9.542 7a9.973 9.973 0 01-4.097 5.197M6.938 6.938L3 3m3.938 3.938l3.124 3.124M21 21l-3.938-3.938m0 0l-3.124-3.124" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function formatNumber(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function formatBytes(bytes) {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatDuration(seconds) {
  if (seconds <= 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// DataLoaderPage
// ---------------------------------------------------------------------------
export default function DataLoaderPage() {
  // Connection
  const [mongoUri, setMongoUri] = useState(import.meta.env.VITE_MONGO_URI || '');
  const [uriVisible, setUriVisible] = useState(false);
  const [dbName, setDbName] = useState('hedwig_bench');
  const [collectionName, setCollectionName] = useState('inbox');
  const [deploymentMode, setDeploymentMode] = useState('replicaSet');

  // Configuration
  const [totalDocs, setTotalDocs] = useState(10000000); // 10M default
  const [docSize, setDocSize] = useState(3);
  const [userPoolSize, setUserPoolSize] = useState(100000);
  const [batchSize, setBatchSize] = useState(1000);
  const [writeConcern, setWriteConcern] = useState('1');
  const [threadCount, setThreadCount] = useState(4);
  const [concurrencyPerThread, setConcurrencyPerThread] = useState(10);
  const [dropBefore, setDropBefore] = useState(false);

  // Document preview
  const [docPreview, setDocPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewTimerRef = useRef(null);

  // Index creation
  const [creatingIndexes, setCreatingIndexes] = useState(false);
  const [indexResult, setIndexResult] = useState(null);

  // Job state
  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null); // running | completed | stopped | failed
  const [progress, setProgress] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);

  // WebSocket
  const wsRef = useRef(null);
  const mountedRef = useRef(true);

  // Debounced doc preview
  useEffect(() => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      setPreviewLoading(true);
      previewLoaderDoc(docSize, userPoolSize)
        .then((data) => setDocPreview(data))
        .catch(() => setDocPreview(null))
        .finally(() => setPreviewLoading(false));
    }, 300);
    return () => { if (previewTimerRef.current) clearTimeout(previewTimerRef.current); };
  }, [docSize, userPoolSize]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  // Connect WebSocket when job starts
  const connectWs = useCallback((jId) => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    const ws = createLoaderWebSocket(jId);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'progress') {
          setProgress(msg.data);
          if (msg.data.status === 'building_indexes') {
            setJobStatus('building_indexes');
          }
        } else if (msg.type === 'status') {
          setProgress(msg.data);
          setJobStatus(msg.data.status);
          if (msg.data.status === 'completed' || msg.data.status === 'stopped') {
            setStopping(false);
          }
        }
      } catch {}
    };

    ws.onclose = () => {
      // Reconnect if job is still running
      if (mountedRef.current && jobStatus === 'running') {
        setTimeout(() => connectWs(jId), 2000);
      }
    };
  }, [jobStatus]);

  // Start job
  const handleStart = useCallback(async () => {
    if (!mongoUri) {
      alert('MongoDB URI is required.');
      return;
    }

    const totalDataSize = totalDocs * docSize * 1024;
    if (dropBefore) {
      if (!window.confirm(`This will DROP the '${collectionName}' collection and then insert ${formatNumber(totalDocs)} documents (${formatBytes(totalDataSize)}). Continue?`)) return;
    } else {
      if (!window.confirm(`This will insert ${formatNumber(totalDocs)} documents (${formatBytes(totalDataSize)}) into '${collectionName}'. Continue?`)) return;
    }

    try {
      setSubmitting(true);
      const result = await startLoaderJob({
        mongoUri,
        dbName,
        collectionName,
        deploymentMode,
        dropCollection: dropBefore,
        totalDocs,
        docSizeKB: docSize,
        userPoolSize,
        batchSize,
        writeConcern,
        threadCount,
        concurrencyPerThread,
      });
      setJobId(result.jobId);
      setJobStatus('running');
      setProgress(null);
      connectWs(result.jobId);
    } catch (err) {
      alert(`Failed to start: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }, [mongoUri, dbName, collectionName, deploymentMode, totalDocs, docSize, userPoolSize, batchSize, writeConcern, threadCount, concurrencyPerThread, connectWs]);

  // Stop job
  const handleStop = useCallback(async () => {
    if (!jobId) return;
    try {
      setStopping(true);
      await stopLoaderJob(jobId);
      setJobStatus('stopped');
    } catch (err) {
      alert(`Failed to stop: ${err.message}`);
    } finally {
      setStopping(false);
    }
  }, [jobId]);

  // Reset
  const handleReset = useCallback(() => {
    setJobId(null);
    setJobStatus(null);
    setProgress(null);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  // Create indexes on demand
  const handleCreateIndexes = useCallback(async () => {
    if (!mongoUri) { alert('MongoDB URI is required.'); return; }
    try {
      setCreatingIndexes(true);
      setIndexResult(null);
      const res = await fetch('/api/loader/create-indexes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mongoUri, dbName, collectionName, deploymentMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setIndexResult(data);
    } catch (err) {
      alert(`Failed to create indexes: ${err.message}`);
    } finally {
      setCreatingIndexes(false);
    }
  }, [mongoUri, dbName, collectionName, deploymentMode]);

  const isRunning = jobStatus === 'running' || jobStatus === 'building_indexes';
  const isFinished = jobStatus === 'completed' || jobStatus === 'stopped' || jobStatus === 'failed';
  const maskedUri = mongoUri.length > 20 ? mongoUri.slice(0, 20) + '...' : mongoUri;
  const totalDataSize = totalDocs * docSize * 1024;
  const progressPct = progress && progress.totalDocs > 0
    ? Math.min(100, (progress.insertedDocs / progress.totalDocs) * 100)
    : 0;

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <h1 className="text-xl font-bold text-white mb-2">Data Loader</h1>
      <p className="text-sm text-gray-400 mb-4">
        Bulk-insert documents into MongoDB using parallel worker threads for maximum throughput.
      </p>

      {/* ── Connection ── */}
      <Section title="Connection">
        <div>
          <Label htmlFor="mongoUri">MongoDB URI</Label>
          {mongoUri ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white font-mono truncate">
                {uriVisible ? mongoUri : maskedUri}
              </div>
              <button type="button" onClick={() => setUriVisible((v) => !v)} className="p-2 text-gray-400 hover:text-gray-200">
                <EyeIcon open={uriVisible} />
              </button>
              <button type="button" onClick={() => { setMongoUri(''); setUriVisible(false); }} className="text-xs text-gray-500 hover:text-gray-300">Clear</button>
            </div>
          ) : (
            <TextInput id="mongoUri" value={mongoUri} onChange={(e) => setMongoUri(e.target.value)} placeholder="mongodb+srv://user:pass@cluster.mongodb.net" />
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="dbName">Database name</Label>
            <TextInput id="dbName" value={dbName} onChange={(e) => setDbName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="collectionName">Collection name</Label>
            <TextInput id="collectionName" value={collectionName} onChange={(e) => setCollectionName(e.target.value)} />
          </div>
        </div>

        <div>
          <Label>Deployment mode</Label>
          <div className="flex rounded-md overflow-hidden border border-gray-700">
            {[
              { value: 'replicaSet', label: 'Replica Set' },
              { value: 'sharded', label: 'Sharded' },
            ].map((opt) => (
              <button key={opt.value} type="button" onClick={() => setDeploymentMode(opt.value)}
                className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                  deploymentMode === opt.value ? 'bg-emerald-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200'
                }`}
              >{opt.label}</button>
            ))}
          </div>
          {deploymentMode === 'sharded' && (
            <p className="text-xs text-gray-500 mt-1">
              Creates {'{ user_id: "hashed" }'} shard key index and shards the collection before inserting.
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={dropBefore} onChange={(e) => setDropBefore(e.target.checked)} className="accent-emerald-500 w-4 h-4" />
          <span className="text-sm text-gray-300">Drop collection before loading</span>
          <span className="text-xs text-gray-500">(removes all existing data + indexes)</span>
        </label>
      </Section>

      {/* ── Document Configuration ── */}
      <Section title="Document Configuration">
        <div>
          <Label htmlFor="totalDocs">Total documents to insert</Label>
          <TextInput
            id="totalDocs"
            type="number"
            value={totalDocs}
            onChange={(e) => setTotalDocs(Number(e.target.value))}
            min={1}
          />
          <p className="text-xs text-gray-500 mt-1">
            {formatNumber(totalDocs)} docs &times; {docSize} KB = {formatBytes(totalDataSize)}
          </p>
        </div>

        <RangeSlider
          id="docSize"
          value={docSize}
          onChange={(e) => setDocSize(Number(e.target.value))}
          min={1} max={50}
          label="Document size"
          unit=" KB"
        />

        <div className="w-1/2">
          <Label htmlFor="userPoolSize">User pool size</Label>
          <TextInput id="userPoolSize" type="number" value={userPoolSize} onChange={(e) => setUserPoolSize(Number(e.target.value))} min={1} />
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm text-gray-400">Document preview</span>
            {previewLoading && <span className="text-xs text-emerald-400 animate-pulse">loading...</span>}
          </div>
          <pre className="bg-gray-900 border border-gray-700 rounded-md p-3 text-xs text-gray-300 font-mono overflow-auto max-h-56">
            {docPreview ? JSON.stringify(docPreview, null, 2) : 'No preview available'}
          </pre>
        </div>
      </Section>

      {/* ── Insert Configuration ── */}
      <Section title="Insert Configuration">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="batchSize">Batch size (docs per insertMany)</Label>
            <TextInput id="batchSize" type="number" value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} min={1} max={10000} />
          </div>
          <div>
            <Label>Write concern</Label>
            <div className="flex rounded-md overflow-hidden border border-gray-700">
              {['1', 'majority'].map((wc) => (
                <button key={wc} type="button" onClick={() => setWriteConcern(wc)}
                  className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                    writeConcern === wc ? 'bg-emerald-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200'
                  }`}
                >w:{wc}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="threadCount">Worker threads</Label>
            <TextInput id="threadCount" type="number" value={threadCount} onChange={(e) => setThreadCount(Number(e.target.value))} min={1} max={32} />
          </div>
          <div>
            <Label htmlFor="concurrencyPerThread">Lanes per thread</Label>
            <TextInput id="concurrencyPerThread" type="number" value={concurrencyPerThread} onChange={(e) => setConcurrencyPerThread(Number(e.target.value))} min={1} max={100} />
          </div>
        </div>

        <p className="text-xs text-gray-500">
          {threadCount} threads &times; {concurrencyPerThread} lanes &times; {batchSize} batch = {(threadCount * concurrencyPerThread).toLocaleString()} concurrent insertMany calls, each inserting {batchSize.toLocaleString()} docs.
        </p>
      </Section>

      {/* ── Controls ── */}
      <Section title="Actions">
        {!isRunning && !isFinished && (
          <button type="button" onClick={handleStart} disabled={submitting}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-md transition-colors"
          >
            {submitting ? 'Starting...' : 'Start Loading'}
          </button>
        )}

        {isRunning && (
          <button type="button" onClick={handleStop} disabled={stopping}
            className="px-6 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-semibold rounded-md transition-colors"
          >
            {stopping ? 'Stopping...' : 'Stop'}
          </button>
        )}

        {isFinished && (
          <div className="flex items-center gap-3">
            <span className={`text-sm font-medium px-3 py-1 rounded-full border ${
              jobStatus === 'completed'
                ? 'bg-green-500/20 text-green-300 border-green-500/30'
                : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
            }`}>{jobStatus}</span>
            <button type="button" onClick={handleReset}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-medium rounded-md transition-colors"
            >New Job</button>
          </div>
        )}

        <div className="border-t border-gray-700 pt-4 mt-2">
          <button type="button" onClick={handleCreateIndexes} disabled={creatingIndexes || isRunning}
            className="px-5 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-gray-200 text-sm font-medium rounded-md transition-colors"
          >
            {creatingIndexes ? 'Creating indexes...' : 'Create Indexes'}
          </button>
          <span className="text-xs text-gray-500 ml-3">
            Creates the 4 benchmark indexes (point read, recent inbox, TTL, filtered inbox)
            {deploymentMode === 'sharded' && ' + shard key index'}
          </span>
          {indexResult && (
            <p className="text-xs text-green-400 mt-1">Indexes created ({indexResult.count} indexes)</p>
          )}
        </div>
      </Section>

      {/* ── Progress ── */}
      {progress && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-100">Progress</h3>

          {/* Progress bar */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-xs text-gray-400">{formatNumber(progress.insertedDocs)} / {formatNumber(progress.totalDocs)}</span>
              <span className="text-xs font-mono text-gray-300">{progressPct.toFixed(1)}%</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
              <div className="bg-emerald-500 h-3 rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <span className="text-xs text-gray-400">Insert Rate</span>
              <p className="text-lg font-mono font-semibold text-gray-100">{formatNumber(progress.rate || 0)}/s</p>
            </div>
            <div>
              <span className="text-xs text-gray-400">Elapsed</span>
              <p className="text-lg font-mono font-semibold text-gray-100">{formatDuration(progress.elapsedSeconds || 0)}</p>
            </div>
            <div>
              <span className="text-xs text-gray-400">ETA</span>
              <p className="text-lg font-mono font-semibold text-gray-100">{formatDuration(progress.etaSeconds || 0)}</p>
            </div>
            <div>
              <span className="text-xs text-gray-400">Errors</span>
              <p className={`text-lg font-mono font-semibold ${(progress.errors || 0) > 0 ? 'text-red-400' : 'text-gray-100'}`}>{(progress.errors || 0).toLocaleString()}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
