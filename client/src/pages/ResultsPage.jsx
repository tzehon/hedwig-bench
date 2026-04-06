import { useParams, Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { getRun } from '../lib/api';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, Brush
} from 'recharts';

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

// ---------------------------------------------------------------------------
// Custom Tooltip (reused from LiveDashboard style)
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
// Summary Card
// ---------------------------------------------------------------------------
function SummaryCard({ title, borderColor, children }) {
  return (
    <div
      className="bg-gray-900 rounded-xl border border-gray-800 p-5"
      style={{ borderLeftWidth: '4px', borderLeftColor: borderColor }}
    >
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verdict logic
// ---------------------------------------------------------------------------
function computeVerdict(summary, config) {
  if (!summary || !config) return { pass: false, reasons: ['No summary data available'] };

  const targetRPS = config.targetWriteRPS || 0;
  const achievedWriteRPS = summary.avgWriteRPS || 0;
  const achievedReadRPS = summary.avgReadRPS || 0;
  const writeP99 = summary.writeP99 || 0;
  const readP99 = summary.readP99 || 0;
  const errorRate = summary.errorRate || 0;

  const rpsRatio = targetRPS > 0 ? achievedWriteRPS / targetRPS : 0;
  const rpsOk = rpsRatio > 0.9;
  const readP99Best = summary.readP99Min || readP99;
  const latencyOk = writeP99 < 50 && readP99Best < 50;
  const errorsOk = errorRate < 1;
  const pass = rpsOk && latencyOk && errorsOk;

  const reasons = [];
  if (!rpsOk) reasons.push(`Achieved only ${(rpsRatio * 100).toFixed(1)}% of target RPS (need >90%)`);
  if (!latencyOk) {
    if (writeP99 >= 50) reasons.push(`Write p99 ${fmt(writeP99)}ms >= 50ms threshold`);
    if (readP99Best >= 50) reasons.push(`Read p99 best ${fmt(readP99Best)}ms >= 50ms threshold`);
  }
  if (!errorsOk) reasons.push(`Error rate ${fmt(errorRate)}% >= 1% threshold`);
  if (pass) reasons.push('All criteria met');

  return { pass, reasons };
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------
function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function generateMarkdownReport(run) {
  const config = run.config || {};
  const summary = run.summary || {};
  const verdict = computeVerdict(summary, config);
  const date = formatDate(run.createdAt || run.startedAt);

  let md = `# Hedwig Bench Report - ${date}\n\n`;

  // Config summary
  md += `## Configuration\n\n`;
  md += `| Parameter | Value |\n`;
  md += `| --- | --- |\n`;
  md += `| Doc Size | ${config.docSize || '--'} KB |\n`;
  md += `| Index Profile | ${config.indexProfile || '--'} |\n`;
  md += `| Write Mode | ${config.writeMode || '--'} |\n`;
  md += `| Write Concern | ${config.writeConcern || '--'} |\n`;
  md += `| Target Write RPS | ${fmt(config.targetWriteRPS, 0)} |\n`;
  md += `| Target Read RPS | ${fmt(config.targetReadRPS, 0)} |\n`;
  md += `| Spikes | ${config.numSpikes || '--'} |\n`;
  md += `\n`;

  // Performance summary
  md += `## Performance Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `| --- | --- |\n`;
  md += `| Peak Write RPS | ${fmt(summary.peakWriteRPS, 0)} |\n`;
  md += `| Avg Write RPS | ${fmt(summary.avgWriteRPS, 0)} |\n`;
  md += `| Write p99 Latency | ${fmt(summary.writeP99)} ms |\n`;
  md += `| Avg Read RPS | ${fmt(summary.avgReadRPS, 0)} |\n`;
  md += `| Read p99 Latency | ${fmt(summary.readP99)} ms |\n`;
  md += `| Error Rate | ${fmt(summary.errorRate)}% |\n`;
  md += `\n`;

  // Verdict
  md += `## Verdict\n\n`;
  md += `**${verdict.pass ? 'PASS' : 'FAIL'}**\n\n`;
  verdict.reasons.forEach((r) => {
    md += `- ${r}\n`;
  });
  md += `\n`;

  // Per-spike breakdown
  if (summary.perSpike && summary.perSpike.length > 0) {
    md += `## Per-Spike Breakdown\n\n`;
    md += `| Spike # | Peak Write RPS | Avg Write Latency (ms) | Peak Read Latency (ms) | Error Count |\n`;
    md += `| --- | --- | --- | --- | --- |\n`;
    summary.perSpike.forEach((spike, i) => {
      md += `| ${i + 1} | ${fmt(spike.peakWriteRPS, 0)} | ${fmt(spike.avgWriteLatency)} | ${fmt(spike.peakReadLatency)} | ${fmt(spike.errorCount, 0)} |\n`;
    });
    md += `\n`;
  }

  return md;
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
// ResultsPage
// ---------------------------------------------------------------------------
export default function ResultsPage() {
  const { id } = useParams();
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    getRun(id)
      .then((data) => {
        setRun(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || 'Failed to load run');
        setLoading(false);
      });
  }, [id]);

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------
  if (loading) {
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
          <span className="text-sm text-gray-400">Loading results...</span>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Error
  // ------------------------------------------------------------------
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="bg-gray-900 rounded-xl border border-red-800 p-8 max-w-md text-center">
          <h2 className="text-lg font-semibold text-red-400 mb-2">Run Not Found</h2>
          <p className="text-sm text-gray-400 mb-4">{error}</p>
          <Link
            to="/"
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-medium rounded-md transition-colors inline-block"
          >
            Back to Configure
          </Link>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Still running
  // ------------------------------------------------------------------
  if (run && run.status === 'running') {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="bg-gray-900 rounded-xl border border-yellow-700 p-8 max-w-md text-center">
          <h2 className="text-lg font-semibold text-yellow-400 mb-2">Run Still In Progress</h2>
          <p className="text-sm text-gray-400 mb-4">
            This benchmark run is still active. View the live dashboard instead.
          </p>
          <Link
            to={`/run/${id}`}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-md transition-colors inline-block"
          >
            Go to Live Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Derived data
  // ------------------------------------------------------------------
  const config = run?.config || {};
  const summary = run?.summary || {};
  const rawTimeseries = run?.timeseries || run?.metrics || [];
  const perSpike = summary.perSpike || [];
  const verdict = computeVerdict(summary, config);

  // Flatten nested timeseries data for Recharts
  const timeseries = rawTimeseries.map((d) => {
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
  });

  // Extract system metrics from timeseries entries that have them
  const systemMetrics = rawTimeseries
    .filter((d) => d.system)
    .map((d) => ({
      time: d.second || 0,
      connections: d.system.connections || 0,
      insertOpsPerSec: d.system.insertOps || 0,
      queryOpsPerSec: d.system.queryOps || 0,
      dirtyCacheBytes: d.system.cacheDirtyBytes || 0,
    }));

  const hasTimeseries = timeseries.length > 0;
  const hasSystemMetrics = systemMetrics.length > 0;

  const writeP99Ok = (summary.writeP99 || 0) < 50;
  const readP99Ok = (summary.readP99Min || summary.readP99 || 0) < 50;

  // ------------------------------------------------------------------
  // Download handlers
  // ------------------------------------------------------------------
  function handleDownloadJSON() {
    const payload = JSON.stringify({
      id: run.id || id,
      config,
      summary,
      timeseries,
      systemMetrics,
    }, null, 2);
    downloadBlob(payload, `hedwig-bench-${id}.json`, 'application/json');
  }

  function handleDownloadMarkdown() {
    const md = generateMarkdownReport(run);
    downloadBlob(md, `hedwig-bench-${id}.md`, 'text/markdown');
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Back navigation */}
      <div className="flex items-center gap-3">
        <Link
          to="/history"
          className="text-sm text-gray-400 hover:text-gray-200 transition-colors flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to History
        </Link>
        <span className="text-gray-600">|</span>
        <span className="text-sm text-gray-300">{config.runName || <span className="font-mono text-gray-500">{truncateId(id)}</span>}</span>
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            run?.status === 'completed'
              ? 'bg-green-500/20 text-green-300 border border-green-500/30'
              : run?.status === 'stopped'
              ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30'
              : 'bg-red-500/20 text-red-300 border border-red-500/30'
          }`}
        >
          {run?.status || 'unknown'}
        </span>
      </div>

      {/* ============================================================= */}
      {/* Summary Cards                                                  */}
      {/* ============================================================= */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Config Card */}
        <SummaryCard title="Configuration" borderColor="#6B7280">
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">Doc Size</span>
              <span className="text-sm text-gray-200 font-mono">{config.docSize || '--'} KB</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">Index Profile</span>
              <span className="text-sm text-gray-200 font-mono">{config.indexProfile || '--'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">Write Mode</span>
              <span className="text-sm text-gray-200 font-mono">{config.writeMode || '--'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">Write Concern</span>
              <span className="text-sm text-gray-200 font-mono">{config.writeConcern || '--'}</span>
            </div>
          </div>
        </SummaryCard>

        {/* Write Performance Card */}
        <SummaryCard
          title="Write Performance"
          borderColor={writeP99Ok ? '#22c55e' : '#ef4444'}
        >
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">Peak Write RPS</span>
              <span className="text-sm text-gray-100 font-mono font-semibold">
                {fmtRPS(summary.peakWriteRPS)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">Avg Sustain RPS</span>
              <span className="text-sm text-gray-100 font-mono font-semibold">
                {fmtRPS(summary.avgWriteRPS)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">p99 Latency</span>
              <span className={`text-sm font-mono font-semibold ${writeP99Ok ? 'text-green-400' : 'text-red-400'}`}>
                {fmt(summary.writeP99)} ms
              </span>
            </div>
          </div>
        </SummaryCard>

        {/* Read Performance Card */}
        <SummaryCard
          title="Read Performance"
          borderColor={readP99Ok ? '#22c55e' : '#ef4444'}
        >
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">Achieved Read RPS</span>
              <span className="text-sm text-gray-100 font-mono font-semibold">
                {fmtRPS(summary.avgReadRPS)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">p99 Latency</span>
              <span className={`text-sm font-mono font-semibold ${(summary.readP99Min || summary.readP99 || 0) < 50 ? 'text-green-400' : 'text-red-400'}`}>
                {fmt(summary.readP99Min || summary.readP99)} ms
              </span>
            </div>
          </div>
        </SummaryCard>

        {/* Verdict Card */}
        <SummaryCard
          title="Verdict"
          borderColor={verdict.pass ? '#22c55e' : '#ef4444'}
        >
          <div className="flex flex-col items-center justify-center h-full">
            <span
              className={`text-3xl font-black tracking-wide ${
                verdict.pass ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {verdict.pass ? 'PASS' : 'FAIL'}
            </span>
            <ul className="mt-3 space-y-1">
              {verdict.reasons.map((r, i) => (
                <li key={i} className="text-xs text-gray-400 text-center">{r}</li>
              ))}
            </ul>
          </div>
        </SummaryCard>
      </div>

      {/* ============================================================= */}
      {/* Full Charts                                                    */}
      {/* ============================================================= */}
      {hasTimeseries ? (
        <>
          {/* Throughput Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Write Throughput */}
            <ChartCard title="Write Throughput">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={timeseries} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid {...chartGridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis
                    {...yAxisProps}
                    tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }} />
                  <Line
                    type="monotone"
                    dataKey="targetWriteRPS"
                    name="Target Write RPS"
                    stroke="#6B7280"
                    strokeDasharray="5 5"
                    dot={false}
                    strokeWidth={1.5}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="actualWriteRPS"
                    name="Actual Write RPS"
                    stroke="#22c55e"
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                  <Brush
                    dataKey="time"
                    height={20}
                    stroke="#4B5563"
                    fill="#1F2937"
                    tickFormatter={(v) => `${v}s`}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Read Throughput */}
            <ChartCard title="Read Throughput">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={timeseries} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid {...chartGridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis
                    {...yAxisProps}
                    tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }} />
                  <Line
                    type="monotone"
                    dataKey="targetReadRPS"
                    name="Target Read RPS"
                    stroke="#6B7280"
                    strokeDasharray="5 5"
                    dot={false}
                    strokeWidth={1.5}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="actualReadRPS"
                    name="Actual Read RPS"
                    stroke="#22c55e"
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                  <Brush
                    dataKey="time"
                    height={20}
                    stroke="#4B5563"
                    fill="#1F2937"
                    tickFormatter={(v) => `${v}s`}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* Latency Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Write Latency */}
            <ChartCard title="Write Latency (per document)">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={timeseries} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
                      value: '50ms threshold',
                      position: 'right',
                      fill: '#9CA3AF',
                      fontSize: 10,
                    }}
                  />
                  <Line type="monotone" dataKey="writeP50" name="p50" stroke="#22c55e" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Line type="monotone" dataKey="writeP95" name="p95" stroke="#eab308" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Line type="monotone" dataKey="writeP99" name="p99" stroke="#ef4444" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Brush
                    dataKey="time"
                    height={20}
                    stroke="#4B5563"
                    fill="#1F2937"
                    tickFormatter={(v) => `${v}s`}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Read Latency */}
            <ChartCard title="Read Latency (per query)">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={timeseries} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
                      value: '50ms threshold',
                      position: 'right',
                      fill: '#9CA3AF',
                      fontSize: 10,
                    }}
                  />
                  <Line type="monotone" dataKey="readP50" name="p50" stroke="#22c55e" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Line type="monotone" dataKey="readP95" name="p95" stroke="#eab308" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Line type="monotone" dataKey="readP99" name="p99" stroke="#ef4444" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Brush
                    dataKey="time"
                    height={20}
                    stroke="#4B5563"
                    fill="#1F2937"
                    tickFormatter={(v) => `${v}s`}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* System Metrics Chart */}
          {hasSystemMetrics && (
            <ChartCard title="System Metrics">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={systemMetrics} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid {...chartGridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis
                    yAxisId="left"
                    {...yAxisProps}
                    tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    stroke="#6B7280"
                    tick={{ fill: '#9CA3AF', fontSize: 11 }}
                    width={70}
                    tickFormatter={(v) => {
                      if (v >= 1e9) return `${(v / 1e9).toFixed(1)}GB`;
                      if (v >= 1e6) return `${(v / 1e6).toFixed(0)}MB`;
                      if (v >= 1e3) return `${(v / 1e3).toFixed(0)}KB`;
                      return v;
                    }}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }} />
                  <Line yAxisId="left" type="monotone" dataKey="connections" name="Connections" stroke="#3b82f6" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Line yAxisId="left" type="monotone" dataKey="insertOpsPerSec" name="Insert ops/sec" stroke="#22c55e" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Line yAxisId="left" type="monotone" dataKey="queryOpsPerSec" name="Query ops/sec" stroke="#eab308" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Line yAxisId="right" type="monotone" dataKey="dirtyCacheBytes" name="Dirty Cache" stroke="#a855f7" dot={false} strokeWidth={1.5} strokeDasharray="4 4" isAnimationActive={false} />
                  <Brush
                    dataKey="time"
                    height={20}
                    stroke="#4B5563"
                    fill="#1F2937"
                    tickFormatter={(v) => `${v}s`}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center">
          <p className="text-sm text-gray-400">
            No timeseries data available. The run may have been stopped before collecting metrics.
          </p>
        </div>
      )}

      {/* ============================================================= */}
      {/* Per-Spike Breakdown Table                                      */}
      {/* ============================================================= */}
      {perSpike.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800">
            <h3 className="text-sm font-semibold text-gray-100">Per-Spike Breakdown</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-800 text-left">
                  <th className="px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Spike #</th>
                  <th className="px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Peak Write RPS</th>
                  <th className="px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Avg Write Latency (ms)</th>
                  <th className="px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Peak Read Latency (ms)</th>
                  <th className="px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Error Count</th>
                </tr>
              </thead>
              <tbody>
                {perSpike.map((spike, i) => (
                  <tr
                    key={i}
                    className={`border-t border-gray-800 ${
                      i % 2 === 0 ? 'bg-gray-900' : 'bg-gray-900/60'
                    }`}
                  >
                    <td className="px-5 py-3 text-gray-200 font-mono">{i + 1}</td>
                    <td className="px-5 py-3 text-gray-200 font-mono">{fmt(spike.peakWriteRPS, 0)}</td>
                    <td className="px-5 py-3 text-gray-200 font-mono">{fmt(spike.avgWriteLatency)}</td>
                    <td className="px-5 py-3 text-gray-200 font-mono">{fmt(spike.peakReadLatency)}</td>
                    <td className={`px-5 py-3 font-mono ${
                      (spike.errorCount || 0) > 0 ? 'text-red-400' : 'text-gray-200'
                    }`}>
                      {fmt(spike.errorCount, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============================================================= */}
      {/* Export Buttons                                                  */}
      {/* ============================================================= */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleDownloadJSON}
          className="px-5 py-2.5 border border-gray-700 hover:bg-gray-800 text-gray-300 text-sm font-medium rounded-md transition-colors flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download JSON
        </button>
        <button
          onClick={handleDownloadMarkdown}
          className="px-5 py-2.5 border border-gray-700 hover:bg-gray-800 text-gray-300 text-sm font-medium rounded-md transition-colors flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download Markdown Report
        </button>
      </div>
    </div>
  );
}
