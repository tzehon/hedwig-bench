import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef, useCallback } from 'react';
import { getRun, stopRun, createWebSocket } from '../lib/api';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from 'recharts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_DISPLAY_SECONDS = 600; // 10 minutes of data visible at once
const SYNC_INTERVAL_MS = 1000;   // sync ref -> state every second
const RECONNECT_DELAY_MS = 2000;

const PHASE_COLORS = {
  ramp: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  sustain: 'bg-green-500/20 text-green-300 border-green-500/30',
  cooldown: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  gap: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  complete: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatElapsed(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function truncateId(id) {
  if (!id) return '';
  return id.length > 12 ? id.slice(0, 12) + '...' : id;
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
// Custom Tooltip
// ---------------------------------------------------------------------------
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md px-3 py-2 shadow-lg">
      <p className="text-xs text-gray-400 mb-1">{label}s</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-xs" style={{ color: entry.color }}>
          {entry.name}: {typeof entry.value === 'number' ? entry.value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : entry.value}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase Badge
// ---------------------------------------------------------------------------
function PhaseBadge({ phase }) {
  const label = phase ? phase.charAt(0).toUpperCase() + phase.slice(1) : 'Unknown';
  const colorClass = PHASE_COLORS[phase] || PHASE_COLORS.gap;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${colorClass}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LiveDashboard
// ---------------------------------------------------------------------------
export default function LiveDashboard() {
  const { id } = useParams();
  const navigate = useNavigate();

  // Run metadata
  const [runConfig, setRunConfig] = useState(null);
  const [runStatus, setRunStatus] = useState('running');
  const [error, setError] = useState(null);

  // Current stats (updated from latest metrics message)
  const [currentStats, setCurrentStats] = useState({
    elapsedSeconds: 0,
    phase: 'ramp',
    progress: 0,
    writeRPS: 0,
    readRPS: 0,
    targetWriteRPS: 0,
    targetReadRPS: 0,
    writeErrors: 0,
    readErrors: 0,
    errorRate: 0,
  });

  // Metrics time series - ref for accumulation, state for rendering
  const metricsRef = useRef([]);
  const [metricsData, setMetricsData] = useState([]);

  // System metrics (less frequent)
  const systemMetricsRef = useRef([]);
  const [systemData, setSystemData] = useState([]);

  // WebSocket state
  const wsRef = useRef(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(true);

  // Stop run state
  const [stopping, setStopping] = useState(false);

  // Sync interval - push ref data to state every second
  const syncTimerRef = useRef(null);

  // ------------------------------------------------------------------
  // Determine if run is finished
  // ------------------------------------------------------------------
  const isFinished = runStatus === 'completed' || runStatus === 'stopped' || runStatus === 'failed';

  // ------------------------------------------------------------------
  // Slice data for display (last 10 min, or all if complete)
  // ------------------------------------------------------------------
  const displayMetrics = useCallback((data) => {
    if (isFinished || data.length <= MAX_DISPLAY_SECONDS) return data;
    return data.slice(-MAX_DISPLAY_SECONDS);
  }, [isFinished]);

  // ------------------------------------------------------------------
  // Connect WebSocket
  // ------------------------------------------------------------------
  const connectWs = useCallback(() => {
    if (!mountedRef.current) return;

    try {
      const ws = createWebSocket(id);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setWsConnected(true);
        setReconnecting(false);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'metrics') {
            const d = msg.data;
            const w = d.write || {};
            const r = d.read || {};
            const sys = d.system || {};

            // Build a data point for the throughput/latency charts
            const point = {
              time: d.second || 0,
              actualWriteRPS: w.ops || 0,
              targetWriteRPS: d.targetWriteRPS || 0,
              actualReadRPS: r.ops || 0,
              targetReadRPS: runConfig?.targetReadRPS || 0,
              writeP50: w.p50 || 0,
              writeP95: w.p95 || 0,
              writeP99: w.p99 || 0,
              readP50: r.p50 || 0,
              readP95: r.p95 || 0,
              readP99: r.p99 || 0,
            };
            metricsRef.current = [...metricsRef.current, point];

            // System metrics (if present - typically every 5s)
            if (sys.connections !== undefined) {
              const sysPoint = {
                time: d.second || 0,
                connections: sys.connections || 0,
                insertOpsPerSec: sys.insertOps || 0,
                queryOpsPerSec: sys.queryOps || 0,
                dirtyCacheBytes: sys.cacheDirtyBytes || 0,
              };
              systemMetricsRef.current = [...systemMetricsRef.current, sysPoint];
            }

            // Update current stats
            const totalOps = (w.ops || 0) + (r.ops || 0);
            const totalErrors = (w.errors || 0) + (r.errors || 0);
            setCurrentStats({
              elapsedSeconds: d.second || 0,
              phase: d.phase || 'ramp',
              progress: d.progress || 0,
              writeRPS: w.ops || 0,
              readRPS: r.ops || 0,
              targetWriteRPS: d.targetWriteRPS || 0,
              targetReadRPS: runConfig?.targetReadRPS || 0,
              writeErrors: w.errors || 0,
              readErrors: r.errors || 0,
              errorRate: totalOps > 0 ? (totalErrors / totalOps) * 100 : 0,
            });
          }

          if (msg.type === 'status') {
            const { status } = msg.data;
            setRunStatus(status);
            if (status === 'completed' || status === 'stopped' || status === 'failed') {
              // Final sync before navigating
              setMetricsData([...metricsRef.current]);
              setSystemData([...systemMetricsRef.current]);
              // Give a moment for the user to see the final state
              setTimeout(() => {
                if (mountedRef.current) {
                  navigate(`/results/${id}`);
                }
              }, 1500);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setWsConnected(false);
        // Only reconnect if the run is not finished
        if (!isFinished) {
          setReconnecting(true);
          reconnectTimerRef.current = setTimeout(() => {
            if (mountedRef.current) connectWs();
          }, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    } catch {
      if (mountedRef.current) {
        setReconnecting(true);
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connectWs();
        }, RECONNECT_DELAY_MS);
      }
    }
  }, [id, isFinished, navigate]);

  // ------------------------------------------------------------------
  // Initial load: fetch run data, connect WS
  // ------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;

    getRun(id)
      .then((run) => {
        if (!mountedRef.current) return;
        setRunConfig(run.config || run);
        setRunStatus(run.status || 'running');

        // If already completed, redirect
        if (run.status === 'completed' || run.status === 'stopped' || run.status === 'failed') {
          navigate(`/results/${id}`, { replace: true });
          return;
        }

        // Load any existing metrics the server may have buffered
        if (run.metrics && Array.isArray(run.metrics)) {
          metricsRef.current = run.metrics;
          setMetricsData(run.metrics);
        }

        // Connect WebSocket
        connectWs();
      })
      .catch((err) => {
        if (mountedRef.current) {
          setError(err.message || 'Failed to load run');
        }
      });

    // Sync timer: push ref data to state every second
    syncTimerRef.current = setInterval(() => {
      if (mountedRef.current) {
        setMetricsData([...metricsRef.current]);
        setSystemData([...systemMetricsRef.current]);
      }
    }, SYNC_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
      }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (syncTimerRef.current) clearInterval(syncTimerRef.current);
    };
  }, [id, navigate, connectWs]);

  // ------------------------------------------------------------------
  // Stop run handler
  // ------------------------------------------------------------------
  const handleStop = useCallback(async () => {
    const confirmed = window.confirm('Are you sure you want to stop this benchmark run?');
    if (!confirmed) return;

    try {
      setStopping(true);
      await stopRun(id);
      // The server will send a status message via WS, but as a fallback:
      setTimeout(() => {
        if (mountedRef.current && runStatus !== 'completed' && runStatus !== 'stopped') {
          navigate(`/results/${id}`);
        }
      }, 5000);
    } catch (err) {
      alert(`Failed to stop run: ${err.message}`);
      setStopping(false);
    }
  }, [id, navigate, runStatus]);

  // ------------------------------------------------------------------
  // Error state
  // ------------------------------------------------------------------
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="bg-gray-900 rounded-xl border border-red-800 p-8 max-w-md text-center">
          <h2 className="text-lg font-semibold text-red-400 mb-2">Run Not Found</h2>
          <p className="text-sm text-gray-400 mb-4">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-medium rounded-md transition-colors"
          >
            Back to Configure
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Derived display data
  // ------------------------------------------------------------------
  const visibleMetrics = displayMetrics(metricsData);
  const visibleSystem = displayMetrics(systemData);

  // Compute progress from elapsed seconds and config
  const totalDuration = runConfig
    ? (runConfig.numSpikes || 1) * ((runConfig.rampSeconds || 120) + (runConfig.sustainSeconds || 180) + 60)
      + Math.max(0, (runConfig.numSpikes || 1) - 1) * (runConfig.gapSeconds || 60)
    : 1;
  const progressPct = Math.min(100, (currentStats.elapsedSeconds / totalDuration) * 100);
  const highErrorRate = currentStats.errorRate > 1;

  // ------------------------------------------------------------------
  // Chart common props
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div className="space-y-4">
      {/* ============================================================= */}
      {/* Top Bar                                                       */}
      {/* ============================================================= */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-4">
            <div>
              <span className="text-xs text-gray-400">Run ID</span>
              <p className="text-sm font-mono text-gray-100">{truncateId(id)}</p>
            </div>
            <div>
              <span className="text-xs text-gray-400">Elapsed</span>
              <p className="text-sm font-mono text-gray-100">
                {formatElapsed(currentStats.elapsedSeconds)}
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-400">Phase</span>
              <div className="mt-0.5">
                <PhaseBadge phase={currentStats.phase} />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Reconnecting indicator */}
            {reconnecting && (
              <span className="text-xs text-yellow-400 animate-pulse">
                Reconnecting...
              </span>
            )}
            {/* WS status dot */}
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                wsConnected ? 'bg-green-400' : 'bg-red-400'
              }`}
              title={wsConnected ? 'Connected' : 'Disconnected'}
            />

            {isFinished ? (
              <button
                onClick={() => navigate(`/results/${id}`)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-md transition-colors"
              >
                View Results
              </button>
            ) : (
              <button
                onClick={handleStop}
                disabled={stopping}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
              >
                {stopping ? 'Stopping...' : 'Stop Run'}
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400">Progress</span>
            <span className="text-xs font-mono text-gray-300">{progressPct.toFixed(1)}%</span>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
            <div
              className="bg-indigo-500 h-2 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* ============================================================= */}
      {/* Charts Row 1 - Throughput                                     */}
      {/* ============================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Write Throughput */}
        <ChartCard title="Write Throughput">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={visibleMetrics} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid {...chartGridProps} />
              <XAxis {...xAxisProps} />
              <YAxis
                {...yAxisProps}
                tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }}
              />
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
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Read Throughput */}
        <ChartCard title="Read Throughput">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={visibleMetrics} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid {...chartGridProps} />
              <XAxis {...xAxisProps} />
              <YAxis
                {...yAxisProps}
                tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }}
              />
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
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ============================================================= */}
      {/* Charts Row 2 - Latency                                        */}
      {/* ============================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Write Latency */}
        <ChartCard title="Write Latency (per document)">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={visibleMetrics} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid {...chartGridProps} />
              <XAxis {...xAxisProps} />
              <YAxis
                {...yAxisProps}
                unit="ms"
                tickFormatter={(v) => v.toFixed(0)}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }}
              />
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
              <Line
                type="monotone"
                dataKey="writeP50"
                name="p50"
                stroke="#22c55e"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="writeP95"
                name="p95"
                stroke="#eab308"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="writeP99"
                name="p99"
                stroke="#ef4444"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Read Latency */}
        <ChartCard title="Read Latency (per query)">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={visibleMetrics} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid {...chartGridProps} />
              <XAxis {...xAxisProps} />
              <YAxis
                {...yAxisProps}
                unit="ms"
                tickFormatter={(v) => v.toFixed(0)}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }}
              />
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
              <Line
                type="monotone"
                dataKey="readP50"
                name="p50"
                stroke="#22c55e"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="readP95"
                name="p95"
                stroke="#eab308"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="readP99"
                name="p99"
                stroke="#ef4444"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ============================================================= */}
      {/* Charts Row 3 - System                                         */}
      {/* ============================================================= */}
      <ChartCard title="System Metrics">
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={visibleSystem} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
            <Legend
              wrapperStyle={{ fontSize: '11px', color: '#9CA3AF' }}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="connections"
              name="Connections"
              stroke="#3b82f6"
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="insertOpsPerSec"
              name="Insert ops/sec"
              stroke="#22c55e"
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="queryOpsPerSec"
              name="Query ops/sec"
              stroke="#eab308"
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="dirtyCacheBytes"
              name="Dirty Cache"
              stroke="#a855f7"
              dot={false}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ============================================================= */}
      {/* Bottom Bar - Error Stats                                      */}
      {/* ============================================================= */}
      <div
        className={`rounded-xl border p-4 transition-colors duration-300 ${
          highErrorRate
            ? 'bg-red-950/60 border-red-700 animate-pulse'
            : 'bg-gray-900 border-gray-800'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div>
              <span className="text-xs text-gray-400">Write Errors</span>
              <p className={`text-lg font-mono font-semibold ${
                currentStats.writeErrors > 0 ? 'text-red-400' : 'text-gray-100'
              }`}>
                {currentStats.writeErrors.toLocaleString()}
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-400">Read Errors</span>
              <p className={`text-lg font-mono font-semibold ${
                currentStats.readErrors > 0 ? 'text-red-400' : 'text-gray-100'
              }`}>
                {currentStats.readErrors.toLocaleString()}
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-400">Error Rate</span>
              <p className={`text-lg font-mono font-semibold ${
                highErrorRate ? 'text-red-400' : currentStats.errorRate > 0 ? 'text-yellow-400' : 'text-gray-100'
              }`}>
                {currentStats.errorRate.toFixed(2)}%
              </p>
            </div>
          </div>

          {highErrorRate && (
            <span className="text-xs font-medium text-red-400 bg-red-500/10 px-3 py-1 rounded-full border border-red-500/20">
              High error rate detected
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
