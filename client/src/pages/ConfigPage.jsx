import { useState, useEffect, useRef, useCallback } from 'react';
import { startRun, previewDoc, cleanup } from '../lib/api';
import { generateSchedule, getTotalDuration } from '../lib/spike';
import { useNavigate } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Collapsible Section
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
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 pb-5 pt-2 space-y-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable input helpers
// ---------------------------------------------------------------------------
function Label({ htmlFor, children }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm text-gray-400 mb-1">
      {children}
    </label>
  );
}

function TextInput({ id, value, onChange, placeholder, required, type = 'text', ...rest }) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      required={required}
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
        <span className="text-sm font-mono text-emerald-300">
          {Number(value).toLocaleString()}{unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        className="w-full accent-emerald-500"
      />
      <div className="flex justify-between text-xs text-gray-500 mt-0.5">
        <span>{Number(min).toLocaleString()}{unit}</span>
        <span>{Number(max).toLocaleString()}{unit}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Eye icon for password toggle
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
// Spike SVG Preview
// ---------------------------------------------------------------------------
function SpikePreview({ targetWriteRPS, numSpikes, rampSeconds, sustainSeconds, gapSeconds, readRPSConcurrent, readRPSIsolation, readIsolationPct }) {
  const schedule = generateSchedule({
    targetWriteRPS,
    numSpikes,
    rampSeconds,
    sustainSeconds,
    gapSeconds,
    readRPSConcurrent,
    readRPSIsolation,
    readIsolationPct,
  });

  if (schedule.length === 0) return null;

  const svgW = 600;
  const svgH = 120;
  const pad = { top: 10, right: 10, bottom: 24, left: 50 };
  const plotW = svgW - pad.left - pad.right;
  const plotH = svgH - pad.top - pad.bottom;

  const maxT = schedule[schedule.length - 1].second;
  const maxRPS = Math.max(targetWriteRPS || 1, readRPSConcurrent || 1, readRPSIsolation || 1);

  const xScale = (s) => pad.left + (s / (maxT || 1)) * plotW;
  const yScale = (rps) => pad.top + plotH - (rps / maxRPS) * plotH;

  // Build write polyline points
  const points = schedule.map((p) => `${xScale(p.second).toFixed(1)},${yScale(p.targetWriteRPS).toFixed(1)}`);

  // Build read polyline points
  const readPoints = schedule.map((p) => `${xScale(p.second).toFixed(1)},${yScale(p.targetReadRPS).toFixed(1)}`);

  // Write area path (fill under curve)
  const areaPath = [
    `M ${xScale(0).toFixed(1)},${yScale(0).toFixed(1)}`,
    ...schedule.map((p) => `L ${xScale(p.second).toFixed(1)},${yScale(p.targetWriteRPS).toFixed(1)}`),
    `L ${xScale(maxT).toFixed(1)},${yScale(0).toFixed(1)}`,
    'Z',
  ].join(' ');

  // Read area path
  const readAreaPath = [
    `M ${xScale(0).toFixed(1)},${yScale(0).toFixed(1)}`,
    ...schedule.map((p) => `L ${xScale(p.second).toFixed(1)},${yScale(p.targetReadRPS).toFixed(1)}`),
    `L ${xScale(maxT).toFixed(1)},${yScale(0).toFixed(1)}`,
    'Z',
  ].join(' ');

  // X-axis tick marks (every minute or so)
  const totalMinutes = maxT / 60;
  const tickInterval = totalMinutes <= 5 ? 1 : totalMinutes <= 15 ? 2 : 5;
  const xTicks = [];
  for (let m = 0; m <= totalMinutes; m += tickInterval) {
    xTicks.push(m);
  }

  return (
    <div className="mt-2">
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="w-full max-w-[600px] h-auto"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Grid lines */}
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + plotH} stroke="#374151" strokeWidth="1" />
        <line x1={pad.left} y1={pad.top + plotH} x2={pad.left + plotW} y2={pad.top + plotH} stroke="#374151" strokeWidth="1" />

        {/* Y-axis labels */}
        <text x={pad.left - 4} y={pad.top + 4} textAnchor="end" className="text-[9px]" fill="#9CA3AF">
          {(maxRPS / 1000).toFixed(0)}k
        </text>
        <text x={pad.left - 4} y={pad.top + plotH / 2 + 3} textAnchor="end" className="text-[9px]" fill="#9CA3AF">
          {(maxRPS / 2000).toFixed(0)}k
        </text>
        <text x={pad.left - 4} y={pad.top + plotH + 3} textAnchor="end" className="text-[9px]" fill="#9CA3AF">
          0
        </text>

        {/* Half-way grid line */}
        <line
          x1={pad.left}
          y1={pad.top + plotH / 2}
          x2={pad.left + plotW}
          y2={pad.top + plotH / 2}
          stroke="#374151"
          strokeWidth="0.5"
          strokeDasharray="4 4"
        />

        {/* X-axis ticks */}
        {xTicks.map((m) => (
          <g key={m}>
            <line
              x1={xScale(m * 60)}
              y1={pad.top + plotH}
              x2={xScale(m * 60)}
              y2={pad.top + plotH + 4}
              stroke="#6B7280"
              strokeWidth="1"
            />
            <text
              x={xScale(m * 60)}
              y={pad.top + plotH + 16}
              textAnchor="middle"
              className="text-[9px]"
              fill="#9CA3AF"
            >
              {m}m
            </text>
          </g>
        ))}

        {/* Write area fill */}
        <path d={areaPath} fill="#818CF8" fillOpacity="0.2" />
        {/* Read area fill */}
        <path d={readAreaPath} fill="#34D399" fillOpacity="0.15" />

        {/* Write line */}
        <polyline points={points.join(' ')} fill="none" stroke="#818CF8" strokeWidth="1.5" />
        {/* Read line */}
        <polyline points={readPoints.join(' ')} fill="none" stroke="#34D399" strokeWidth="1.5" strokeDasharray="4 2" />

        {/* Legend */}
        <line x1={pad.left + 4} y1={pad.top + 2} x2={pad.left + 20} y2={pad.top + 2} stroke="#818CF8" strokeWidth="1.5" />
        <text x={pad.left + 24} y={pad.top + 5} className="text-[8px]" fill="#818CF8">Write</text>
        <line x1={pad.left + 58} y1={pad.top + 2} x2={pad.left + 74} y2={pad.top + 2} stroke="#34D399" strokeWidth="1.5" strokeDasharray="4 2" />
        <text x={pad.left + 78} y={pad.top + 5} className="text-[8px]" fill="#34D399">Read</text>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Format duration (seconds -> "Xm Ys")
// ---------------------------------------------------------------------------
function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ---------------------------------------------------------------------------
// ConfigPage
// ---------------------------------------------------------------------------
export default function ConfigPage() {
  const navigate = useNavigate();

  // -- Run Name --
  const [runName, setRunName] = useState('');

  // -- Connection --
  const [mongoUri, setMongoUri] = useState(import.meta.env.VITE_MONGO_URI || '');
  const [uriVisible, setUriVisible] = useState(false);
  const [dbName, setDbName] = useState('hedwig_bench');
  const [collectionName, setCollectionName] = useState('inbox');
  const [poolSize, setPoolSize] = useState(200);

  // -- Document Shape --
  const [docSize, setDocSize] = useState(3);
  const [userPoolSize, setUserPoolSize] = useState(100000);
  const [docPreview, setDocPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // -- Index Profile --
  const [indexProfile] = useState('extended');

  // -- Write Config --
  const [writeMode, setWriteMode] = useState('bulk');
  const [batchSize, setBatchSize] = useState(500);
  const [targetWriteRPS, setTargetWriteRPS] = useState(35000);
  const [writeConcern, setWriteConcern] = useState('w:majority');
  const [uncapped, setUncapped] = useState(false);
  const [writeLanes, setWriteLanes] = useState(50);

  // -- Read Config --
  const [readMode, setReadMode] = useState('variable'); // 'constant' | 'variable'
  const [readRPSConcurrent, setReadRPSConcurrent] = useState(8000);
  const [readRPSIsolation, setReadRPSIsolation] = useState(2000);
  const [readIsolationPct, setReadIsolationPct] = useState(40);
  const [readLanes, setReadLanes] = useState(150);

  // -- Spike Pattern --
  const [numSpikes, setNumSpikes] = useState(2);
  const [rampSeconds, setRampSeconds] = useState(60);
  const [sustainSeconds, setSustainSeconds] = useState(120);
  const [gapSeconds, setGapSeconds] = useState(30);

  // -- Actions --
  // 'none' | 'deleteData' | 'dropCollection'
  const [dropMode, setDropMode] = useState('none');
  const [submitting, setSubmitting] = useState(false);

  // -- Cleanup --
  const [cleaningUp, setCleaningUp] = useState(false);
  const [clearHistory, setClearHistory] = useState(true);
  const [cleanupResult, setCleanupResult] = useState(null);

  // -- Debounced doc preview --
  const timerRef = useRef(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setPreviewLoading(true);
      previewDoc(docSize, userPoolSize)
        .then((data) => setDocPreview(data))
        .catch(() => setDocPreview(null))
        .finally(() => setPreviewLoading(false));
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [docSize, userPoolSize]);

  // -- Computed total duration --
  const totalDuration = getTotalDuration({ numSpikes, rampSeconds, sustainSeconds, gapSeconds, readIsolationPct });

  // -- Build config object --
  const buildConfig = useCallback(
    (overrides = {}) => ({
      runName: runName || undefined,
      mongoUri,
      dbName,
      collectionName,
      poolSize,
      docSize,
      userPoolSize,
      indexProfile,
      writeMode,
      batchSize: writeMode === 'bulk' ? batchSize : 1,
      targetWriteRPS,
      writeConcern,
      uncapped,
      writeConcurrency: writeLanes,
      readRPSConcurrent,
      readRPSIsolation,
      readIsolationPct,
      readConcurrency: readLanes,
      numSpikes,
      rampSeconds,
      sustainSeconds,
      gapSeconds,
      dropCollection: dropMode === 'dropCollection',
      deleteData: dropMode === 'deleteData',
      ...overrides,
    }),
    [
      runName, mongoUri, dbName, collectionName, poolSize, docSize, userPoolSize,
      indexProfile, writeMode, batchSize, targetWriteRPS, writeConcern, uncapped, writeLanes,
      readRPSConcurrent, readRPSIsolation, readIsolationPct, readLanes,
      numSpikes, rampSeconds, sustainSeconds, gapSeconds,
      dropMode,
    ],
  );

  // -- Start benchmark --
  const handleStart = useCallback(
    async (overrides = {}) => {
      const config = buildConfig(overrides);

      if (!config.mongoUri) {
        alert('MongoDB URI is required.');
        return;
      }

      const proceed = window.confirm(
        `This will generate up to ${Number(config.targetWriteRPS).toLocaleString()} write ops/sec against the configured cluster. Continue?`,
      );
      if (!proceed) return;

      if (config.dropCollection) {
        if (!window.confirm(`This will DROP the '${config.collectionName}' collection (data + indexes). Continue?`)) return;
      } else if (config.deleteData) {
        if (!window.confirm(`This will DELETE all documents from '${config.collectionName}' but keep indexes. Continue?`)) return;
      }

      try {
        setSubmitting(true);
        const result = await startRun(config);
        navigate(`/run/${result.id}`);
      } catch (err) {
        alert(`Failed to start run: ${err.message}`);
      } finally {
        setSubmitting(false);
      }
    },
    [buildConfig, navigate],
  );

  // -- Quick Smoke Test --
  const handleSmokeTest = useCallback(() => {
    setNumSpikes(1);
    setTargetWriteRPS(5000);
    setReadMode('constant');
    setReadRPSConcurrent(500);
    setReadRPSIsolation(500);
    setReadIsolationPct(0);
    setRampSeconds(10);
    setSustainSeconds(30);
    setGapSeconds(10);

    // Use a microtask so state is conceptually set before we call handleStart.
    // We pass overrides directly so the current call uses smoke-test values.
    setTimeout(() => {
      handleStart({
        numSpikes: 1,
        targetWriteRPS: 5000,
        readRPSConcurrent: 500,
        readRPSIsolation: 500,
        readIsolationPct: 0,
        rampSeconds: 10,
        sustainSeconds: 30,
        gapSeconds: 10,
      });
    }, 0);
  }, [handleStart]);

  // -- Cleanup --
  const handleCleanup = useCallback(async () => {
    if (!mongoUri) {
      alert('Enter a MongoDB URI first.');
      return;
    }
    const msg = clearHistory
      ? `This will DROP the '${collectionName}' collection in '${dbName}' and clear all local run history. Continue?`
      : `This will DROP the '${collectionName}' collection in '${dbName}'. All benchmark data will be deleted. Continue?`;
    if (!window.confirm(msg)) return;

    try {
      setCleaningUp(true);
      setCleanupResult(null);
      const result = await cleanup({ mongoUri, dbName, collectionName, clearHistory });
      setCleanupResult(result.results);
    } catch (err) {
      alert(`Cleanup failed: ${err.message}`);
    } finally {
      setCleaningUp(false);
    }
  }, [mongoUri, dbName, collectionName, clearHistory]);

  // -- Masked URI display --
  const maskedUri =
    mongoUri.length > 20 ? mongoUri.slice(0, 20) + '...' : mongoUri;


  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <h1 className="text-xl font-bold text-white mb-2">Configure &amp; Run</h1>

      <div>
        <Label htmlFor="runName">Run name (optional)</Label>
        <TextInput
          id="runName"
          value={runName}
          onChange={(e) => setRunName(e.target.value)}
          placeholder="e.g. M80 NVMe - 35k baseline"
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Connection                                                       */}
      {/* ---------------------------------------------------------------- */}
      <Section title="Connection">
        <div>
          <Label htmlFor="mongoUri">MongoDB URI</Label>
          {mongoUri ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white font-mono truncate">
                {uriVisible ? mongoUri : maskedUri}
              </div>
              <button
                type="button"
                onClick={() => setUriVisible((v) => !v)}
                className="p-2 text-gray-400 hover:text-gray-200 transition-colors"
                title={uriVisible ? 'Hide URI' : 'Show URI'}
              >
                <EyeIcon open={uriVisible} />
              </button>
              <button
                type="button"
                onClick={() => { setMongoUri(''); setUriVisible(false); }}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                Clear
              </button>
            </div>
          ) : (
            <TextInput
              id="mongoUri"
              value={mongoUri}
              onChange={(e) => setMongoUri(e.target.value)}
              placeholder="mongodb+srv://user:pass@cluster.mongodb.net"
              required
            />
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

        <div className="w-1/2">
          <Label htmlFor="poolSize">Connection pool size</Label>
          <TextInput
            id="poolSize"
            type="number"
            value={poolSize}
            onChange={(e) => setPoolSize(Number(e.target.value))}
            min={1}
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Document Shape                                                   */}
      {/* ---------------------------------------------------------------- */}
      <Section title="Document Shape">
        <RangeSlider
          id="docSize"
          value={docSize}
          onChange={(e) => setDocSize(Number(e.target.value))}
          min={1}
          max={50}
          label="Document size"
          unit=" KB"
        />

        <div className="w-1/2">
          <Label htmlFor="userPoolSize">User pool size</Label>
          <TextInput
            id="userPoolSize"
            type="number"
            value={userPoolSize}
            onChange={(e) => setUserPoolSize(Number(e.target.value))}
            min={1}
          />
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm text-gray-400">Live document preview</span>
            {previewLoading && (
              <span className="text-xs text-emerald-400 animate-pulse">loading...</span>
            )}
          </div>
          <pre className="bg-gray-900 border border-gray-700 rounded-md p-3 text-xs text-gray-300 font-mono overflow-auto max-h-56">
            {docPreview ? JSON.stringify(docPreview, null, 2) : 'No preview available'}
          </pre>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Write Configuration                                              */}
      {/* ---------------------------------------------------------------- */}
      <Section title="Write Configuration">
        <div className="grid grid-cols-2 gap-4">
          {/* Write mode */}
          <div>
            <Label>Write mode</Label>
            <div className="flex rounded-md overflow-hidden border border-gray-700">
              {['bulk', 'single'].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setWriteMode(mode)}
                  className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                    writeMode === mode
                      ? 'bg-emerald-600 text-white'
                      : 'bg-gray-900 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Batch size (shown only for bulk) */}
          {writeMode === 'bulk' && (
            <div>
              <Label htmlFor="batchSize">Batch size</Label>
              <TextInput
                id="batchSize"
                type="number"
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
                min={1}
              />
            </div>
          )}
        </div>

        <RangeSlider
          id="targetWriteRPS"
          value={targetWriteRPS}
          onChange={(e) => setTargetWriteRPS(Number(e.target.value))}
          min={1000}
          max={50000}
          step={1000}
          label="Target peak write RPS"
        />

        <div>
          <Label>Write concern</Label>
          <div className="px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-sm text-white w-fit">
            w:majority
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={uncapped}
            onChange={(e) => setUncapped(e.target.checked)}
            className="accent-emerald-500 w-4 h-4"
          />
          <span className="text-sm text-gray-300">Uncapped mode</span>
          <span className="text-xs text-gray-500">(no rate limiter — find max throughput)</span>
        </label>

        <div className="w-1/2">
          <Label htmlFor="writeLanes">Write concurrency (lanes)</Label>
          <TextInput
            id="writeLanes"
            type="number"
            value={writeLanes}
            onChange={(e) => setWriteLanes(Number(e.target.value))}
            min={1}
            max={500}
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Read Configuration                                               */}
      {/* ---------------------------------------------------------------- */}
      <Section title="Read Configuration">
        {/* Mode toggle */}
        <div>
          <Label>Read mode</Label>
          <div className="flex rounded-md overflow-hidden border border-gray-700 mb-2">
            {[
              { value: 'constant', label: 'Constant' },
              { value: 'variable', label: 'Variable' },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setReadMode(opt.value)}
                className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                  readMode === opt.value
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-900 text-gray-400 hover:text-gray-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            {readMode === 'constant'
              ? 'Constant: reads run at a fixed rate throughout the entire benchmark, concurrent with writes. Matches the legacy behavior — useful as a baseline.'
              : 'Variable: reads vary between min and max RPS, with a configurable percentage of the run dedicated to read-only isolation (no concurrent writes). Tests both contention and isolation performance.'}
          </p>
        </div>

        {readMode === 'constant' ? (
          /* Constant mode: single slider */
          <RangeSlider
            id="readRPSConstant"
            value={readRPSConcurrent}
            onChange={(e) => {
              const v = Number(e.target.value);
              setReadRPSConcurrent(v);
              setReadRPSIsolation(v);
              setReadIsolationPct(0);
            }}
            min={100}
            max={15000}
            step={100}
            label="Target read RPS"
          />
        ) : (
          /* Variable mode: concurrent + isolation rates */
          <>
            <div className="grid grid-cols-2 gap-4">
              <RangeSlider
                id="readRPSConcurrent"
                value={readRPSConcurrent}
                onChange={(e) => setReadRPSConcurrent(Number(e.target.value))}
                min={100}
                max={20000}
                step={100}
                label="Concurrent read RPS (with writes)"
              />
              <RangeSlider
                id="readRPSIsolation"
                value={readRPSIsolation}
                onChange={(e) => setReadRPSIsolation(Number(e.target.value))}
                min={100}
                max={20000}
                step={100}
                label="Isolation read RPS (read-only)"
              />
            </div>

            <RangeSlider
              id="readIsolationPct"
              value={readIsolationPct}
              onChange={(e) => setReadIsolationPct(Number(e.target.value))}
              min={0}
              max={80}
              step={5}
              label="Read isolation (% of run without writes)"
              unit="%"
            />
            {readIsolationPct > 0 && (
              <p className="text-xs text-gray-500">
                {100 - readIsolationPct}% concurrent at {readRPSConcurrent.toLocaleString()} RPS (point reads, 1 item) +{' '}
                {readIsolationPct}% isolation at {readRPSIsolation.toLocaleString()} RPS (list queries, 1&ndash;50 items).
              </p>
            )}
          </>
        )}

        <div className="w-1/2">
          <Label htmlFor="readLanes">Read concurrency (lanes)</Label>
          <TextInput
            id="readLanes"
            type="number"
            value={readLanes}
            onChange={(e) => setReadLanes(Number(e.target.value))}
            min={1}
            max={500}
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Spike Pattern                                                    */}
      {/* ---------------------------------------------------------------- */}
      <Section title="Spike Pattern">
        <RangeSlider
          id="numSpikes"
          value={numSpikes}
          onChange={(e) => setNumSpikes(Number(e.target.value))}
          min={1}
          max={10}
          label="Number of spikes"
        />

        <div className="grid grid-cols-2 gap-4">
          <RangeSlider
            id="rampSeconds"
            value={rampSeconds}
            onChange={(e) => setRampSeconds(Number(e.target.value))}
            min={30}
            max={300}
            step={10}
            label="Ramp-up"
            unit="s"
          />
          <RangeSlider
            id="sustainSeconds"
            value={sustainSeconds}
            onChange={(e) => setSustainSeconds(Number(e.target.value))}
            min={30}
            max={600}
            step={10}
            label="Sustain"
            unit="s"
          />
        </div>

        <RangeSlider
          id="gapSeconds"
          value={gapSeconds}
          onChange={(e) => setGapSeconds(Number(e.target.value))}
          min={30}
          max={300}
          step={10}
          label="Gap between spikes"
          unit="s"
        />

        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-400">Total duration:</span>
          <span className="text-white font-medium">{formatDuration(totalDuration)}</span>
        </div>

        <div>
          <span className="text-sm text-gray-400">Spike pattern preview</span>
          <SpikePreview
            targetWriteRPS={targetWriteRPS}
            numSpikes={numSpikes}
            rampSeconds={rampSeconds}
            sustainSeconds={sustainSeconds}
            gapSeconds={gapSeconds}
            readRPSConcurrent={readRPSConcurrent}
            readRPSIsolation={readRPSIsolation}
            readIsolationPct={readIsolationPct}
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Actions                                                          */}
      {/* ---------------------------------------------------------------- */}
      <Section title="Actions">
        <div className="space-y-2">
          <span className="text-sm text-gray-400">Before run</span>
          {[
            { value: 'none', label: 'Keep existing data', desc: 'Benchmark against existing documents' },
            { value: 'deleteData', label: 'Delete data, keep indexes', desc: 'Removes all documents but preserves indexes' },
            { value: 'dropCollection', label: 'Drop collection', desc: 'Removes everything (data + indexes), recreates indexes' },
          ].map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-2.5 rounded-md cursor-pointer border transition-colors ${
                dropMode === opt.value
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-gray-700 bg-gray-900 hover:border-gray-600'
              }`}
            >
              <input
                type="radio"
                name="dropMode"
                value={opt.value}
                checked={dropMode === opt.value}
                onChange={(e) => setDropMode(e.target.value)}
                className="mt-0.5 accent-emerald-500"
              />
              <div>
                <div className="text-sm text-white">{opt.label}</div>
                <div className="text-xs text-gray-500">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => handleStart()}
            disabled={submitting}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-md transition-colors"
          >
            {submitting ? 'Starting...' : 'Start Benchmark'}
          </button>

          <button
            type="button"
            onClick={handleSmokeTest}
            disabled={submitting}
            className="px-5 py-2.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-gray-200 text-sm font-medium rounded-md transition-colors"
          >
            Quick Smoke Test
          </button>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Cleanup                                                          */}
      {/* ---------------------------------------------------------------- */}
      <Section title="Cleanup" defaultOpen={false}>
        <p className="text-sm text-gray-400 mb-3">
          Drop the benchmark collection from Atlas and optionally clear local run history.
        </p>

        <label className="flex items-center gap-2 cursor-pointer mb-4">
          <input
            type="checkbox"
            checked={clearHistory}
            onChange={(e) => setClearHistory(e.target.checked)}
            className="accent-emerald-500 w-4 h-4"
          />
          <span className="text-sm text-gray-300">Also clear local run history</span>
        </label>

        <button
          type="button"
          onClick={handleCleanup}
          disabled={cleaningUp}
          className="px-5 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-md transition-colors"
        >
          {cleaningUp ? 'Cleaning up...' : 'Cleanup'}
        </button>

        {cleanupResult && (
          <div className="mt-3 p-3 bg-gray-900 border border-gray-700 rounded-md text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className={cleanupResult.collection ? 'text-green-400' : 'text-red-400'}>
                {cleanupResult.collection ? '\u2713' : '\u2717'}
              </span>
              <span className="text-gray-300">Collection dropped</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={cleanupResult.searchIndex ? 'text-green-400' : 'text-red-400'}>
                {cleanupResult.searchIndex ? '\u2713' : '\u2717'}
              </span>
              <span className="text-gray-300">Search index removed</span>
            </div>
            {clearHistory && (
              <div className="flex items-center gap-2">
                <span className={cleanupResult.history ? 'text-green-400' : 'text-red-400'}>
                  {cleanupResult.history ? '\u2713' : '\u2717'}
                </span>
                <span className="text-gray-300">Local run history cleared</span>
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
