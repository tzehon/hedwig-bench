import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { listRuns, getRun, deleteRun, clearAllRuns } from '../lib/api';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from 'recharts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const COMPARE_PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444'];

const STATUS_STYLES = {
  completed: 'bg-green-500/20 text-green-300 border border-green-500/30',
  stopped: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30',
  failed: 'bg-red-500/20 text-red-300 border border-red-500/30',
  running: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function truncateId(id) {
  if (!id) return '';
  return id.length > 12 ? id.slice(0, 12) + '...' : id;
}

function fmt(v, digits = 1) {
  if (v == null) return '--';
  return typeof v === 'number'
    ? v.toLocaleString(undefined, { maximumFractionDigits: digits })
    : String(v);
}

function fmtRPS(v) {
  if (v == null) return '--';
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return fmt(v, 0);
}

function formatDate(iso) {
  if (!iso) return 'N/A';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function computeVerdict(summary, config) {
  if (!summary || !config) return { pass: false };
  const targetRPS = config.targetWriteRPS || 0;
  const achievedWriteRPS = summary.avgWriteRPS || 0;
  const writeP99 = summary.writeP99 || 0;
  const readP99 = summary.readP99 || 0;
  const errorRate = summary.errorRate || 0;
  const rpsRatio = targetRPS > 0 ? achievedWriteRPS / targetRPS : 0;
  const pass = rpsRatio > 0.9 && writeP99 < 50 && readP99 < 50 && errorRate < 1;
  return { pass };
}

// ---------------------------------------------------------------------------
// Custom Tooltip (reused from project convention)
// ---------------------------------------------------------------------------
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md px-3 py-2 shadow-lg">
      <p className="text-xs text-gray-400 mb-1">{label}s</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-xs" style={{ color: entry.color }}>
          {entry.name}: {typeof entry.value === 'number'
            ? entry.value.toLocaleString(undefined, { maximumFractionDigits: 1 })
            : entry.value}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart Card wrapper
// ---------------------------------------------------------------------------
function ChartCard({ title, children }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <h3 className="text-sm font-semibold text-gray-100 mb-3">{title}</h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart common props
// ---------------------------------------------------------------------------
const chartGridProps = {
  strokeDasharray: '3 3',
  stroke: '#374151',
};

const xAxisProps = {
  dataKey: 'time',
  stroke: '#6B7280',
  tick: { fill: '#9CA3AF', fontSize: 11 },
  tickFormatter: (v) => `${v}s`,
  interval: 'preserveStartEnd',
  minTickGap: 50,
};

const yAxisProps = {
  stroke: '#6B7280',
  tick: { fill: '#9CA3AF', fontSize: 11 },
  width: 60,
};

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------
function Spinner({ text }) {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="flex flex-col items-center gap-3">
        <svg
          className="animate-spin h-8 w-8 text-emerald-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm text-gray-400">{text || 'Loading...'}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build overlay chart data
// ---------------------------------------------------------------------------
// Merges timeseries from multiple runs into a single array keyed by time.
// Each run gets its own data key (e.g. writeRPS_0, writeRPS_1).
function buildOverlayData(compareData, dataKey) {
  const timeMap = new Map();

  compareData.forEach((run, runIdx) => {
    const ts = run.timeseries || run.metrics || [];
    ts.forEach((point) => {
      const t = point.time;
      if (!timeMap.has(t)) timeMap.set(t, { time: t });
      timeMap.get(t)[`${dataKey}_${runIdx}`] = point[dataKey];
    });
  });

  return Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Comparison summary table helpers
// ---------------------------------------------------------------------------
const CONFIG_FIELDS = [
  { key: 'docSize', label: 'Doc Size (KB)', path: 'config' },
  { key: 'writeMode', label: 'Write Mode', path: 'config' },
  { key: 'indexProfile', label: 'Index Profile', path: 'config' },
  { key: 'writeConcern', label: 'Write Concern', path: 'config' },
  { key: 'targetWriteRPS', label: 'Target Write RPS', path: 'config' },
  { key: 'batchSize', label: 'Batch Size', path: 'config' },
];

const PERF_FIELDS = [
  { key: 'peakWriteRPS', label: 'Peak Write RPS', path: 'summary', format: fmtRPS },
  { key: 'avgWriteRPS', label: 'Avg Write RPS', path: 'summary', format: fmtRPS },
  { key: 'writeP99', label: 'Write p99 (ms)', path: 'summary', format: (v) => fmt(v) },
  { key: 'avgReadRPS', label: 'Read RPS', path: 'summary', format: fmtRPS },
  { key: 'readP99', label: 'Read p99 (ms)', path: 'summary', format: (v) => fmt(v) },
  { key: 'errorRate', label: 'Error Rate (%)', path: 'summary', format: (v) => fmt(v) },
  { key: 'verdict', label: 'Verdict', path: 'computed' },
];

function getFieldValue(run, field) {
  if (field.path === 'config') {
    return (run.config || {})[field.key];
  }
  if (field.path === 'summary') {
    return (run.summary || {})[field.key];
  }
  if (field.path === 'computed' && field.key === 'verdict') {
    const v = computeVerdict(run.summary, run.config);
    return v.pass ? 'PASS' : 'FAIL';
  }
  return undefined;
}

function valuesAreDifferent(runs, field) {
  const values = runs.map((r) => {
    const v = getFieldValue(r, field);
    return v == null ? '' : String(v);
  });
  return new Set(values).size > 1;
}

// ---------------------------------------------------------------------------
// HistoryPage
// ---------------------------------------------------------------------------
export default function HistoryPage() {
  const [runs, setRuns] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [comparing, setComparing] = useState(false);
  const [compareData, setCompareData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [compareLoading, setCompareLoading] = useState(false);

  // ------------------------------------------------------------------
  // Fetch runs
  // ------------------------------------------------------------------
  const fetchRuns = () => {
    setLoading(true);
    listRuns()
      .then((data) => {
        const sorted = (Array.isArray(data) ? data : [])
          .slice()
          .sort((a, b) => {
            const da = new Date(a.createdAt || a.startedAt || 0);
            const db = new Date(b.createdAt || b.startedAt || 0);
            return db - da;
          });
        setRuns(sorted);
        setLoading(false);
      })
      .catch(() => {
        setRuns([]);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchRuns();
  }, []);

  // ------------------------------------------------------------------
  // Selection handlers
  // ------------------------------------------------------------------
  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const canCompare = selected.size >= 2 && selected.size <= 4;

  // ------------------------------------------------------------------
  // Compare handler
  // ------------------------------------------------------------------
  async function handleCompare() {
    if (!canCompare) return;
    setCompareLoading(true);
    try {
      const promises = Array.from(selected).map((id) => getRun(id));
      const results = await Promise.all(promises);
      // Flatten nested timeseries for Recharts
      const flattened = results.map((run) => {
        const raw = run.timeseries || run.metrics || [];
        const config = run.config || {};
        return {
          ...run,
          timeseries: raw.map((d) => {
            const w = d.write || {};
            const r = d.read || {};
            return {
              time: d.second || 0,
              actualWriteRPS: w.ops || 0,
              targetWriteRPS: d.targetWriteRPS || 0,
              actualReadRPS: r.ops || 0,
              targetReadRPS: config.targetReadRPS || 0,
              writeP50: w.p50 || 0,
              writeP95: w.p95 || 0,
              writeP99: w.p99 || 0,
              readP50: r.p50 || 0,
              readP95: r.p95 || 0,
              readP99: r.p99 || 0,
            };
          }),
        };
      });
      setCompareData(flattened);
      setComparing(true);
    } catch {
      alert('Failed to load one or more runs for comparison.');
    } finally {
      setCompareLoading(false);
    }
  }

  function handleCloseCompare() {
    setComparing(false);
    setCompareData([]);
  }

  // ------------------------------------------------------------------
  // Delete handler
  // ------------------------------------------------------------------
  async function handleDelete(id) {
    const confirmed = window.confirm(
      'Are you sure you want to delete this run? This cannot be undone.'
    );
    if (!confirmed) return;

    try {
      await deleteRun(id);
      // Remove from selection if selected
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // Remove from compareData if comparing
      setCompareData((prev) => prev.filter((r) => (r.id || r._id) !== id));
      // Refresh list
      fetchRuns();
    } catch (err) {
      alert(`Failed to delete run: ${err.message}`);
    }
  }

  // ------------------------------------------------------------------
  // Loading state
  // ------------------------------------------------------------------
  if (loading) {
    return <Spinner text="Loading run history..." />;
  }

  // ------------------------------------------------------------------
  // Empty state
  // ------------------------------------------------------------------
  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 max-w-md text-center">
          <svg
            className="w-12 h-12 text-gray-600 mx-auto mb-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
            />
          </svg>
          <h2 className="text-lg font-semibold text-gray-200 mb-2">No runs yet</h2>
          <p className="text-sm text-gray-400 mb-4">
            Start a benchmark to see results here.
          </p>
          <Link
            to="/"
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-md transition-colors inline-block"
          >
            Configure a Benchmark
          </Link>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Build overlay chart datasets for comparison
  // ------------------------------------------------------------------
  const writeThroughputData = comparing ? buildOverlayData(compareData, 'actualWriteRPS') : [];
  const readThroughputData = comparing ? buildOverlayData(compareData, 'actualReadRPS') : [];
  const writeLatencyData = comparing ? buildOverlayData(compareData, 'writeP99') : [];
  const readLatencyData = comparing ? buildOverlayData(compareData, 'readP99') : [];

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-100">History & Compare</h1>
        <p className="text-sm text-gray-400 mt-1">
          View past benchmark runs and compare performance across configurations.
        </p>
      </div>

      {/* ============================================================= */}
      {/* Toolbar                                                        */}
      {/* ============================================================= */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative group">
            <button
              onClick={handleCompare}
              disabled={!canCompare || compareLoading}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
                canCompare
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              {compareLoading ? (
                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
                </svg>
              )}
              Compare Selected
            </button>
            {!canCompare && selected.size > 0 && (
              <div className="absolute bottom-full left-0 mb-2 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Select 2-4 runs to compare
              </div>
            )}
          </div>
          <span className="text-xs text-gray-500">
            {selected.size === 0
              ? 'Select runs to compare'
              : `${selected.size} run${selected.size > 1 ? 's' : ''} selected`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {comparing && (
            <button
              onClick={handleCloseCompare}
              className="px-4 py-2 text-sm font-medium rounded-md border border-gray-700 hover:bg-gray-800 text-gray-300 transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Close Compare
            </button>
          )}
          <button
            onClick={async () => {
              if (!window.confirm('Delete all run history? This cannot be undone.')) return;
              await clearAllRuns();
              setSelected(new Set());
              setComparing(false);
              setCompareData([]);
              fetchRuns();
            }}
            disabled={runs.length === 0}
            className="px-4 py-2 text-sm font-medium rounded-md border border-red-800 hover:bg-red-900/50 text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Clear History
          </button>
        </div>
      </div>

      {/* ============================================================= */}
      {/* Runs Table                                                     */}
      {/* ============================================================= */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-800 text-left">
                <th className="px-4 py-3 w-10">
                  <span className="sr-only">Select</span>
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Run ID</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Date</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Doc Size</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Write Mode</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Index Profile</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Peak Write RPS</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">p99 Write Lat.</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Verdict</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const id = run.id || run._id;
                const config = run.config || {};
                const summary = run.summary || {};
                const verdict = computeVerdict(summary, config);
                const isSelected = selected.has(id);
                const statusClass = STATUS_STYLES[run.status] || STATUS_STYLES.failed;

                return (
                  <tr
                    key={id}
                    className={`border-t border-gray-800 transition-colors ${
                      isSelected ? 'bg-emerald-950/30' : 'hover:bg-gray-800/50'
                    }`}
                  >
                    {/* Checkbox */}
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(id)}
                        className="accent-emerald-500 w-4 h-4 rounded cursor-pointer"
                      />
                    </td>

                    {/* Run ID */}
                    <td className="px-4 py-3">
                      <Link
                        to={`/results/${id}`}
                        className="text-emerald-400 hover:text-emerald-300 font-mono text-xs transition-colors"
                      >
                        {truncateId(id)}
                      </Link>
                    </td>

                    {/* Date */}
                    <td className="px-4 py-3 text-gray-300 text-xs">
                      {formatDate(run.createdAt || run.startedAt)}
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusClass}`}>
                        {run.status || 'unknown'}
                      </span>
                    </td>

                    {/* Doc Size */}
                    <td className="px-4 py-3 text-gray-300 font-mono text-xs">
                      {config.docSize ? `${config.docSize} KB` : '--'}
                    </td>

                    {/* Write Mode */}
                    <td className="px-4 py-3 text-gray-300 font-mono text-xs">
                      {config.writeMode || '--'}
                    </td>

                    {/* Index Profile */}
                    <td className="px-4 py-3 text-gray-300 font-mono text-xs">
                      {config.indexProfile || '--'}
                    </td>

                    {/* Peak Write RPS */}
                    <td className="px-4 py-3 text-gray-200 font-mono text-xs font-semibold">
                      {fmtRPS(summary.peakWriteRPS)}
                    </td>

                    {/* p99 Write Latency */}
                    <td className="px-4 py-3 font-mono text-xs">
                      <span className={
                        summary.writeP99 != null
                          ? summary.writeP99 < 50 ? 'text-green-400' : 'text-red-400'
                          : 'text-gray-400'
                      }>
                        {summary.writeP99 != null ? `${fmt(summary.writeP99)} ms` : '--'}
                      </span>
                    </td>

                    {/* Verdict */}
                    <td className="px-4 py-3">
                      {summary.peakWriteRPS != null ? (
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          verdict.pass
                            ? 'bg-green-500/20 text-green-300 border border-green-500/30'
                            : 'bg-red-500/20 text-red-300 border border-red-500/30'
                        }`}>
                          {verdict.pass ? 'PASS' : 'FAIL'}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-500">--</span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDelete(id)}
                        className="text-red-400 hover:text-red-300 text-xs transition-colors"
                        title="Delete run"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ============================================================= */}
      {/* Compare View                                                   */}
      {/* ============================================================= */}
      {comparing && compareData.length >= 2 && (
        <div className="space-y-6">
          {/* Section header */}
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-gray-100">Comparison</h2>
            <div className="flex items-center gap-2">
              {compareData.map((run, i) => (
                <span
                  key={run.id || run._id || i}
                  className="inline-flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 rounded-full border border-gray-700 bg-gray-800"
                >
                  <span
                    className="w-2 h-2 rounded-full inline-block"
                    style={{ backgroundColor: COMPARE_PALETTE[i] }}
                  />
                  {truncateId(run.id || run._id)}
                </span>
              ))}
            </div>
          </div>

          {/* Overlay Charts (2x2 grid) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Write Throughput Comparison */}
            <ChartCard title="Write Throughput Comparison">
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={writeThroughputData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid {...chartGridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis
                    {...yAxisProps}
                    tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }} />
                  {compareData.map((run, i) => (
                    <Line
                      key={`write_tp_${i}`}
                      type="monotone"
                      dataKey={`actualWriteRPS_${i}`}
                      name={truncateId(run.id || run._id)}
                      stroke={COMPARE_PALETTE[i]}
                      dot={false}
                      strokeWidth={2}
                      isAnimationActive={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Read Throughput Comparison */}
            <ChartCard title="Read Throughput Comparison">
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={readThroughputData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid {...chartGridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis
                    {...yAxisProps}
                    tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }} />
                  {compareData.map((run, i) => (
                    <Line
                      key={`read_tp_${i}`}
                      type="monotone"
                      dataKey={`actualReadRPS_${i}`}
                      name={truncateId(run.id || run._id)}
                      stroke={COMPARE_PALETTE[i]}
                      dot={false}
                      strokeWidth={2}
                      isAnimationActive={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Write Latency Comparison (p99) */}
            <ChartCard title="Write Latency Comparison (p99)">
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={writeLatencyData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid {...chartGridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis
                    {...yAxisProps}
                    unit="ms"
                    tickFormatter={(v) => v.toFixed(0)}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }} />
                  <ReferenceLine
                    y={50}
                    stroke="#ffffff"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    label={{
                      value: '50ms',
                      position: 'right',
                      fill: '#9CA3AF',
                      fontSize: 10,
                    }}
                  />
                  {compareData.map((run, i) => (
                    <Line
                      key={`write_lat_${i}`}
                      type="monotone"
                      dataKey={`writeP99_${i}`}
                      name={truncateId(run.id || run._id)}
                      stroke={COMPARE_PALETTE[i]}
                      dot={false}
                      strokeWidth={2}
                      isAnimationActive={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Read Latency Comparison (p99) */}
            <ChartCard title="Read Latency Comparison (p99)">
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={readLatencyData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid {...chartGridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis
                    {...yAxisProps}
                    unit="ms"
                    tickFormatter={(v) => v.toFixed(0)}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }} />
                  <ReferenceLine
                    y={50}
                    stroke="#ffffff"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    label={{
                      value: '50ms',
                      position: 'right',
                      fill: '#9CA3AF',
                      fontSize: 10,
                    }}
                  />
                  {compareData.map((run, i) => (
                    <Line
                      key={`read_lat_${i}`}
                      type="monotone"
                      dataKey={`readP99_${i}`}
                      name={truncateId(run.id || run._id)}
                      stroke={COMPARE_PALETTE[i]}
                      dot={false}
                      strokeWidth={2}
                      isAnimationActive={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* Side-by-Side Summary Table */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-gray-100">Side-by-Side Summary</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-800 text-left">
                    <th className="px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Metric
                    </th>
                    {compareData.map((run, i) => (
                      <th
                        key={run.id || run._id || i}
                        className="px-5 py-3 text-xs font-semibold uppercase tracking-wider"
                        style={{ color: COMPARE_PALETTE[i] }}
                      >
                        <span className="flex items-center gap-1.5">
                          <span
                            className="w-2 h-2 rounded-full inline-block"
                            style={{ backgroundColor: COMPARE_PALETTE[i] }}
                          />
                          {truncateId(run.id || run._id)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* Config section header */}
                  <tr className="bg-gray-800/50">
                    <td
                      colSpan={compareData.length + 1}
                      className="px-5 py-2 text-xs font-bold text-gray-400 uppercase tracking-widest"
                    >
                      Configuration
                    </td>
                  </tr>
                  {CONFIG_FIELDS.map((field, rowIdx) => {
                    const isDiff = valuesAreDifferent(compareData, field);
                    return (
                      <tr
                        key={field.key}
                        className={`border-t border-gray-800 ${
                          rowIdx % 2 === 0 ? 'bg-gray-900' : 'bg-gray-900/60'
                        }`}
                      >
                        <td className="px-5 py-2.5 text-xs text-gray-400 font-medium">
                          {field.label}
                        </td>
                        {compareData.map((run, i) => {
                          const val = getFieldValue(run, field);
                          return (
                            <td
                              key={i}
                              className={`px-5 py-2.5 text-xs font-mono text-gray-200 ${
                                isDiff ? 'bg-emerald-900/30' : ''
                              }`}
                            >
                              {val != null ? String(val) : '--'}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}

                  {/* Performance section header */}
                  <tr className="bg-gray-800/50">
                    <td
                      colSpan={compareData.length + 1}
                      className="px-5 py-2 text-xs font-bold text-gray-400 uppercase tracking-widest"
                    >
                      Performance
                    </td>
                  </tr>
                  {PERF_FIELDS.map((field, rowIdx) => {
                    const isDiff = valuesAreDifferent(compareData, field);
                    return (
                      <tr
                        key={field.key}
                        className={`border-t border-gray-800 ${
                          rowIdx % 2 === 0 ? 'bg-gray-900' : 'bg-gray-900/60'
                        }`}
                      >
                        <td className="px-5 py-2.5 text-xs text-gray-400 font-medium">
                          {field.label}
                        </td>
                        {compareData.map((run, i) => {
                          const val = getFieldValue(run, field);
                          const isVerdict = field.key === 'verdict';

                          if (isVerdict) {
                            const isPass = val === 'PASS';
                            return (
                              <td
                                key={i}
                                className={`px-5 py-2.5 ${isDiff ? 'bg-emerald-900/30' : ''}`}
                              >
                                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                                  isPass
                                    ? 'bg-green-500/20 text-green-300 border border-green-500/30'
                                    : 'bg-red-500/20 text-red-300 border border-red-500/30'
                                }`}>
                                  {val}
                                </span>
                              </td>
                            );
                          }

                          const formatted = field.format ? field.format(val) : (val != null ? String(val) : '--');
                          return (
                            <td
                              key={i}
                              className={`px-5 py-2.5 text-xs font-mono text-gray-200 ${
                                isDiff ? 'bg-emerald-900/30' : ''
                              }`}
                            >
                              {formatted}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
