import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_KEY = 'hedwig_query_session';

const QUERY_TYPES = [
  {
    id: 'point_read',
    label: 'Point Read',
    description: 'Fetch a single message by user + msg_id',
    icon: '\u2316',
  },
  {
    id: 'recent_messages',
    label: 'Recent Messages',
    description: "Fetch user's recent inbox (last 24h)",
    icon: '\u29D7',
  },
  {
    id: 'filtered_inbox',
    label: 'Filtered Inbox',
    description: "Fetch user's messages by status",
    icon: '\u29E6',
  },
];

const SCYLLA_COMPARISONS = {
  point_read: {
    query: 'SELECT * FROM inbox WHERE pk = ? AND msg_id = ?',
    note: 'Both databases handle this efficiently with primary/compound key lookup.',
  },
  recent_messages: {
    query: 'SELECT * FROM inbox WHERE pk = ? AND created_at > ? LIMIT ?',
    note: 'MongoDB uses compound index {user_id:1, created_at:-1}, Scylla uses clustering key ordering.',
  },
  filtered_inbox: {
    query: 'SELECT * FROM inbox WHERE pk = ? AND status = ? ORDER BY created_at DESC LIMIT ? ALLOW FILTERING',
    note: 'MongoDB can use compound index {user_id:1, status:1, created_at:-1} to avoid the collection scan that Scylla\'s ALLOW FILTERING implies.',
  },
};

const STATUSES = ['delivered', 'read', 'unread'];

// ---------------------------------------------------------------------------
// Helper: Eye icon for password toggle
// ---------------------------------------------------------------------------
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
// Helper: Chevron icon
// ---------------------------------------------------------------------------
function ChevronIcon({ open }) {
  return (
    <svg
      className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helper: Truncate body field
// ---------------------------------------------------------------------------
function truncateBody(val) {
  if (typeof val !== 'string') return val;
  if (val.length <= 50) return val;
  return val.slice(0, 50) + '...';
}

// ---------------------------------------------------------------------------
// Helper: Format JSON for display with syntax coloring
// ---------------------------------------------------------------------------
function formatJsonValue(val, depth = 0) {
  if (val === null) return <span className="text-gray-500">null</span>;
  if (val === undefined) return <span className="text-gray-500">undefined</span>;
  if (typeof val === 'boolean') return <span className="text-emerald-300">{val.toString()}</span>;
  if (typeof val === 'number') return <span className="text-emerald-300">{val}</span>;
  if (typeof val === 'string') return <span className="text-green-300">"{val}"</span>;
  return null;
}

function JsonDisplay({ data, truncateBodyField = false }) {
  if (!data) return null;

  const formatValue = (key, val, depth) => {
    if (truncateBodyField && key === 'body' && typeof val === 'string') {
      val = truncateBody(val);
    }
    const simple = formatJsonValue(val, depth);
    if (simple) return simple;
    if (Array.isArray(val)) {
      if (val.length === 0) return <span className="text-gray-500">[]</span>;
      return (
        <span>
          <span className="text-gray-500">[</span>
          <div className="ml-4">
            {val.map((item, i) => (
              <div key={i}>
                {typeof item === 'object' && item !== null ? (
                  <JsonDisplay data={item} truncateBodyField={truncateBodyField} />
                ) : (
                  formatJsonValue(item, depth + 1)
                )}
                {i < val.length - 1 && <span className="text-gray-600">,</span>}
              </div>
            ))}
          </div>
          <span className="text-gray-500">]</span>
        </span>
      );
    }
    if (typeof val === 'object') {
      return <JsonDisplay data={val} truncateBodyField={truncateBodyField} />;
    }
    return <span className="text-gray-400">{String(val)}</span>;
  };

  const entries = Object.entries(data);
  return (
    <div className="ml-2">
      <span className="text-gray-500">{'{'}</span>
      <div className="ml-4">
        {entries.map(([key, val], i) => (
          <div key={key} className="leading-relaxed">
            <span className="text-gray-400">"{key}"</span>
            <span className="text-gray-600">: </span>
            {formatValue(key, val, 0)}
            {i < entries.length - 1 && <span className="text-gray-600">,</span>}
          </div>
        ))}
      </div>
      <span className="text-gray-500">{'}'}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: Dice icon (random button)
// ---------------------------------------------------------------------------
function DiceIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h16v16H4V4z" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="16" cy="16" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// QueryPage
// ---------------------------------------------------------------------------
export default function QueryPage() {
  // -- Connection state --
  const [mongoUri, setMongoUri] = useState(import.meta.env.VITE_MONGO_URI || '');
  const [uriVisible, setUriVisible] = useState(false);
  const [dbName, setDbName] = useState('hedwig_bench');
  const [collectionName, setCollectionName] = useState('inbox');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [connectionOpen, setConnectionOpen] = useState(true);

  // -- Sample IDs --
  const [sampleUsers, setSampleUsers] = useState([]);
  const [sampleMsgIds, setSampleMsgIds] = useState([]);
  const [sampleCampaignIds, setSampleCampaignIds] = useState([]);

  // -- Query state --
  const [selectedType, setSelectedType] = useState('point_read');
  const [queryParams, setQueryParams] = useState({
    userId: '',
    msgId: '',
    status: 'delivered',
    limit: 20,
    campaignId: '',
  });
  const [running, setRunning] = useState(false);
  const [queryResult, setQueryResult] = useState(null);
  const [queryError, setQueryError] = useState('');
  const [roundTripMs, setRoundTripMs] = useState(null);
  const [showRawExplain, setShowRawExplain] = useState(false);

  // -- Session restore --
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.dbName) setDbName(data.dbName);
        if (data.collectionName) setCollectionName(data.collectionName);
      }
    } catch {
      // ignore
    }
  }, []);

  // -- Connect --
  const handleConnect = useCallback(async () => {
    if (!mongoUri) {
      setConnectError('MongoDB URI is required.');
      return;
    }
    setConnecting(true);
    setConnectError('');
    try {
      const res = await fetch('/api/queries/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mongoUri, dbName, collectionName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to connect');
      setConnected(true);
      setConnectionOpen(false);
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ dbName, collectionName }));
      } catch {
        // ignore
      }
      // Fetch sample IDs
      fetchSampleIds();
    } catch (err) {
      setConnectError(err.message);
    } finally {
      setConnecting(false);
    }
  }, [mongoUri, dbName, collectionName]);

  // -- Fetch sample IDs --
  const fetchSampleIds = useCallback(async () => {
    try {
      const res = await fetch('/api/queries/sample-ids');
      const data = await res.json();
      if (res.ok) {
        setSampleUsers(data.users || []);
        setSampleMsgIds(data.msgIds || []);
        setSampleCampaignIds(data.campaignIds || []);
        // Auto-populate first values
        if (data.users?.length > 0) {
          setQueryParams((p) => ({ ...p, userId: p.userId || data.users[0] }));
        }
        if (data.msgIds?.length > 0) {
          setQueryParams((p) => ({ ...p, msgId: p.msgId || data.msgIds[0] }));
        }
        if (data.campaignIds?.length > 0) {
          setQueryParams((p) => ({ ...p, campaignId: p.campaignId || data.campaignIds[0] }));
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // -- Random pick helpers --
  const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)] || '';

  const randomizeUserId = () => {
    if (sampleUsers.length > 0) {
      setQueryParams((p) => ({ ...p, userId: pickRandom(sampleUsers) }));
    }
  };
  const randomizeMsgId = () => {
    if (sampleMsgIds.length > 0) {
      setQueryParams((p) => ({ ...p, msgId: pickRandom(sampleMsgIds) }));
    }
  };
  const randomizeCampaignId = () => {
    if (sampleCampaignIds.length > 0) {
      setQueryParams((p) => ({ ...p, campaignId: pickRandom(sampleCampaignIds) }));
    }
  };
  const randomizeStatus = () => {
    setQueryParams((p) => ({ ...p, status: pickRandom(STATUSES) }));
  };

  // -- Run Query --
  const handleRunQuery = useCallback(async () => {
    setRunning(true);
    setQueryError('');
    setQueryResult(null);
    setRoundTripMs(null);
    setShowRawExplain(false);

    const params = {};
    switch (selectedType) {
      case 'point_read':
        params.userId = queryParams.userId;
        params.msgId = queryParams.msgId;
        break;
      case 'recent_messages':
        params.userId = queryParams.userId;
        params.limit = parseInt(queryParams.limit, 10) || 20;
        break;
      case 'filtered_inbox':
        params.userId = queryParams.userId;
        params.status = queryParams.status;
        params.limit = parseInt(queryParams.limit, 10) || 20;
        break;
    }

    const start = performance.now();
    try {
      const res = await fetch('/api/queries/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: selectedType, params }),
      });
      const data = await res.json();
      const rtt = Math.round((performance.now() - start) * 100) / 100;
      setRoundTripMs(rtt);

      if (!res.ok) throw new Error(data.error || 'Query failed');
      setQueryResult(data);
    } catch (err) {
      setQueryError(err.message);
    } finally {
      setRunning(false);
    }
  }, [selectedType, queryParams]);

  // -- Is collection empty check --
  const isEmpty = queryResult && queryResult.count === 0 && !queryError;

  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Query Demo</h1>
        <p className="text-sm text-gray-400 mt-1">
          Interactive MongoDB query patterns — the Scylla-equivalent workloads running against your benchmark collection.
        </p>
      </div>

      {/* ── Connection Section ────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <button
          onClick={() => setConnectionOpen((o) => !o)}
          className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-800/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-200">MongoDB Connection</h2>
            {connected && (
              <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                Connected
              </span>
            )}
          </div>
          <ChevronIcon open={connectionOpen} />
        </button>

        {connectionOpen && (
          <div className="px-5 pb-4 border-t border-gray-800">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
              {/* URI */}
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-gray-400 mb-1">MongoDB URI</label>
                <div className="relative">
                  <input
                    type={uriVisible ? 'text' : 'password'}
                    value={mongoUri}
                    onChange={(e) => setMongoUri(e.target.value)}
                    placeholder="mongodb+srv://..."
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setUriVisible((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                  >
                    <EyeIcon open={uriVisible} />
                  </button>
                </div>
              </div>

              {/* DB Name */}
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Database</label>
                <input
                  type="text"
                  value={dbName}
                  onChange={(e) => setDbName(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              {/* Collection */}
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Collection</label>
                <input
                  type="text"
                  value={collectionName}
                  onChange={(e) => setCollectionName(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            </div>

            {connectError && (
              <p className="text-sm text-red-400 mt-2">{connectError}</p>
            )}

            <button
              onClick={handleConnect}
              disabled={connecting}
              className="mt-3 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        )}
      </div>

      {/* ── Main Content (visible only when connected) ──────── */}
      {connected && (
        <div className="space-y-6">
          {/* Query Type Tabs */}
          <div className="flex flex-wrap gap-2">
            {QUERY_TYPES.map((qt) => (
              <button
                key={qt.id}
                onClick={() => {
                  setSelectedType(qt.id);
                  setQueryResult(null);
                  setQueryError('');
                  setRoundTripMs(null);
                }}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                  selectedType === qt.id
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                    : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-700'
                }`}
              >
                <span className="text-base">{qt.icon}</span>
                <div className="text-left">
                  <div>{qt.label}</div>
                  <div className="text-xs font-normal opacity-70">{qt.description}</div>
                </div>
              </button>
            ))}
          </div>

          {/* Input Section + Run Button */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-200 mb-3">Parameters</h3>
            <div className="flex flex-wrap items-end gap-3">
              {/* user_id — shown for point_read, recent_messages, filtered_inbox */}
              {['point_read', 'recent_messages', 'filtered_inbox'].includes(selectedType) && (
                <div className="min-w-[200px]">
                  <label className="block text-xs font-medium text-gray-400 mb-1">user_id</label>
                  <div className="flex gap-1">
                    <select
                      value={queryParams.userId}
                      onChange={(e) => setQueryParams((p) => ({ ...p, userId: e.target.value }))}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
                    >
                      <option value="">Select...</option>
                      {sampleUsers.map((u) => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                    <button
                      onClick={randomizeUserId}
                      title="Random user_id"
                      className="px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-emerald-300 hover:border-emerald-500/50 transition-colors"
                    >
                      <DiceIcon />
                    </button>
                  </div>
                </div>
              )}

              {/* msg_id — point_read only */}
              {selectedType === 'point_read' && (
                <div className="min-w-[200px]">
                  <label className="block text-xs font-medium text-gray-400 mb-1">msg_id</label>
                  <div className="flex gap-1">
                    <select
                      value={queryParams.msgId}
                      onChange={(e) => setQueryParams((p) => ({ ...p, msgId: e.target.value }))}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
                    >
                      <option value="">Select...</option>
                      {sampleMsgIds.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <button
                      onClick={randomizeMsgId}
                      title="Random msg_id"
                      className="px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-emerald-300 hover:border-emerald-500/50 transition-colors"
                    >
                      <DiceIcon />
                    </button>
                  </div>
                </div>
              )}

              {/* status — filtered_inbox only */}
              {selectedType === 'filtered_inbox' && (
                <div className="min-w-[160px]">
                  <label className="block text-xs font-medium text-gray-400 mb-1">status</label>
                  <div className="flex gap-1">
                    <select
                      value={queryParams.status}
                      onChange={(e) => setQueryParams((p) => ({ ...p, status: e.target.value }))}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                    <button
                      onClick={randomizeStatus}
                      title="Random status"
                      className="px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-emerald-300 hover:border-emerald-500/50 transition-colors"
                    >
                      <DiceIcon />
                    </button>
                  </div>
                </div>
              )}

              {/* limit — recent_messages, filtered_inbox */}
              {['recent_messages', 'filtered_inbox'].includes(selectedType) && (
                <div className="w-24">
                  <label className="block text-xs font-medium text-gray-400 mb-1">limit</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={queryParams.limit}
                    onChange={(e) => setQueryParams((p) => ({ ...p, limit: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              )}

              {/* Run Button */}
              <button
                onClick={handleRunQuery}
                disabled={running}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
              >
                {running ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Run Query
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {queryError && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
              {queryError}
            </div>
          )}

          {/* Results Section */}
          {queryResult && (
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Left: Query + Results (3/5) */}
              <div className="lg:col-span-3 space-y-4">
                {/* Query Display */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Query</h3>
                  <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 font-mono text-sm text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">
                    {queryResult.queryDescription}
                  </div>
                </div>

                {/* Results */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Results</h3>
                    <span className="text-xs text-gray-500">
                      {queryResult.count} document{queryResult.count !== 1 ? 's' : ''} returned
                    </span>
                  </div>

                  {isEmpty && (
                    <div className="text-center py-8 text-gray-500">
                      <p className="text-sm">No data yet -- run a benchmark first to populate the collection.</p>
                    </div>
                  )}

                  {queryResult.results.length > 0 && (
                    <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 font-mono text-xs overflow-auto max-h-[500px]">
                      {queryResult.results.map((doc, i) => (
                        <div key={i} className={i > 0 ? 'mt-3 pt-3 border-t border-gray-800' : ''}>
                          <JsonDisplay data={doc} truncateBodyField />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Performance + Explain + Scylla (2/5) */}
              <div className="lg:col-span-2 space-y-4">
                {/* Performance Card */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Performance</h3>
                  <div className="space-y-3">
                    <PerfRow
                      label="Execution time"
                      value={queryResult.explain?.executionTimeMillis != null ? `${queryResult.explain.executionTimeMillis} ms` : 'N/A'}
                      sub="Server-side (from explain)"
                    />
                    <PerfRow
                      label="Round-trip time"
                      value={roundTripMs != null ? `${roundTripMs} ms` : 'N/A'}
                      sub="Client measurement"
                    />
                    <PerfRow
                      label="Docs examined"
                      value={queryResult.explain?.totalDocsExamined ?? 'N/A'}
                    />
                    <PerfRow
                      label="Keys examined"
                      value={queryResult.explain?.totalKeysExamined ?? 'N/A'}
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Index used</span>
                      {queryResult.explain?.indexUsed ? (
                        <span className="text-sm font-medium text-green-300 font-mono">
                          {queryResult.explain.indexUsed}
                        </span>
                      ) : queryResult.explain?.stage === 'COLLSCAN' ? (
                        <span className="text-sm font-medium text-red-400">Collection Scan</span>
                      ) : (
                        <span className="text-sm text-gray-500">N/A</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Stage</span>
                      <span className={`text-sm font-medium font-mono ${
                        queryResult.explain?.stage === 'COLLSCAN'
                          ? 'text-red-400'
                          : queryResult.explain?.stage === 'IXSCAN'
                            ? 'text-green-300'
                            : 'text-gray-300'
                      }`}>
                        {queryResult.explain?.stage || 'N/A'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Explain (collapsible) */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setShowRawExplain((o) => !o)}
                    className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-800/50 transition-colors"
                  >
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Raw Explain</h3>
                    <ChevronIcon open={showRawExplain} />
                  </button>
                  {showRawExplain && (
                    <div className="px-5 pb-4 border-t border-gray-800">
                      <pre className="bg-gray-950 border border-gray-800 rounded-lg p-4 font-mono text-xs text-gray-400 overflow-auto max-h-[400px] mt-3 whitespace-pre-wrap">
                        {queryResult.rawExplain
                          ? JSON.stringify(queryResult.rawExplain, null, 2)
                          : 'Explain not available for this query type.'}
                      </pre>
                    </div>
                  )}
                </div>

                {/* Scylla Comparison */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                    Scylla Comparison
                  </h3>
                  <ScyllaComparison type={selectedType} />
                </div>
              </div>
            </div>
          )}

          {/* Pre-run state: show all Scylla comparisons as info */}
          {!queryResult && !queryError && (
            <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-6">
              <h3 className="text-sm font-semibold text-gray-300 mb-4">
                Scylla-equivalent Query Patterns
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                Select a query type above and run it to see results, execution stats, and explain plans.
                Below is a preview of what each pattern demonstrates.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {QUERY_TYPES.map((qt) => (
                  <div
                    key={qt.id}
                    className="bg-gray-900 border border-gray-800 rounded-lg p-4 cursor-pointer hover:border-emerald-500/30 transition-colors"
                    onClick={() => setSelectedType(qt.id)}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-base">{qt.icon}</span>
                      <span className="text-sm font-medium text-gray-200">{qt.label}</span>
                    </div>
                    <p className="text-xs text-gray-500 mb-2">{qt.description}</p>
                    <p className="text-xs text-gray-400">{SCYLLA_COMPARISONS[qt.id].note}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PerfRow({ label, value, sub }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <span className="text-sm text-gray-400">{label}</span>
        {sub && <span className="text-xs text-gray-600 ml-1">({sub})</span>}
      </div>
      <span className="text-sm font-medium text-gray-200 font-mono">{value}</span>
    </div>
  );
}

function ScyllaComparison({ type }) {
  const info = SCYLLA_COMPARISONS[type];
  if (!info) return null;

  return (
    <div className="space-y-3">
      {info.query && (
        <div>
          <p className="text-xs text-gray-500 mb-1">Scylla CQL:</p>
          <code className="block bg-gray-950 border border-gray-800 rounded-lg p-3 font-mono text-xs text-emerald-300 overflow-x-auto">
            {info.query}
          </code>
        </div>
      )}
      {!info.query && (
        <div>
          <p className="text-xs text-gray-500 mb-1">Scylla CQL:</p>
          <p className="text-xs text-gray-500 italic">No direct CQL equivalent</p>
        </div>
      )}
      <p className="text-xs text-gray-400 leading-relaxed">{info.note}</p>
    </div>
  );
}
