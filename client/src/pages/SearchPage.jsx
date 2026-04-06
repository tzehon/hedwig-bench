import { useState, useEffect, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_KEY = 'hedwig_search_session';
const PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Helper: Render highlights from Atlas Search
// ---------------------------------------------------------------------------
function renderHighlights(highlights, path) {
  if (!highlights || !Array.isArray(highlights)) return null;
  const match = highlights.find((h) => h.path === path);
  if (!match || !match.texts) return null;
  return (
    <span>
      {match.texts.map((seg, i) =>
        seg.type === 'hit' ? (
          <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">
            {seg.value}
          </mark>
        ) : (
          <span key={i}>{seg.value}</span>
        )
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helper: Status badge
// ---------------------------------------------------------------------------
function StatusBadge({ status }) {
  const colors = {
    delivered: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    read: 'bg-green-500/20 text-green-300 border-green-500/30',
    unread: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  };
  const cls = colors[status] || 'bg-gray-500/20 text-gray-300 border-gray-500/30';
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full border ${cls}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helper: Format date
// ---------------------------------------------------------------------------
function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Eye icon for password toggle (matching ConfigPage)
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
// Search icon
// ---------------------------------------------------------------------------
function SearchIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Refresh icon
// ---------------------------------------------------------------------------
function RefreshIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Chevron icon for collapsible
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
// Capability card for the sidebar
// ---------------------------------------------------------------------------
function CapabilityCard({ title, description }) {
  return (
    <div className="bg-gray-900/50 border-l-2 border-emerald-500 rounded-r-lg p-3">
      <h4 className="text-sm font-semibold text-gray-200 mb-1">{title}</h4>
      <p className="text-sm text-gray-400 leading-relaxed">{description}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capabilities data
// ---------------------------------------------------------------------------
const CAPABILITIES = [
  {
    title: 'Full-Text Search',
    description:
      'Search across subject and body fields with fuzzy matching — something ScyllaDB can\'t do without an external search engine.',
  },
  {
    title: 'Autocomplete',
    description: 'Real-time type-ahead suggestions powered by edge n-grams.',
  },
  {
    title: 'Faceted Filtering',
    description:
      'Combine text search with structured filters (status, user, date range) in a single query.',
  },
  {
    title: 'Relevance Scoring',
    description:
      'Results ranked by relevance using Lucene scoring — no manual ranking needed.',
  },
  {
    title: 'Highlighting',
    description:
      'Search terms highlighted in results, powered by Atlas Search highlighting.',
  },
];

// ---------------------------------------------------------------------------
// SearchPage
// ---------------------------------------------------------------------------
export default function SearchPage() {
  // -- Connection state --
  const [mongoUri, setMongoUri] = useState(import.meta.env.VITE_MONGO_URI || '');
  const [uriVisible, setUriVisible] = useState(false);
  const [dbName, setDbName] = useState('hedwig_bench');
  const [collectionName, setCollectionName] = useState('inbox');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  // -- Index state --
  const [indexStatus, setIndexStatus] = useState(null); // null | 'none' | 'building' | 'ready'
  const [indexChecking, setIndexChecking] = useState(false);
  const [indexCreating, setIndexCreating] = useState(false);

  // -- Connection section collapsible --
  const [connectionOpen, setConnectionOpen] = useState(true);

  // -- Search state --
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [latencyMs, setLatencyMs] = useState(null);
  const [totalResults, setTotalResults] = useState(0);
  const [page, setPage] = useState(1);

  // -- Filters --
  const [filterStatus, setFilterStatus] = useState('');
  const [filterUserId, setFilterUserId] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  // -- Refs --
  const autocompleteTimerRef = useRef(null);
  const searchInputRef = useRef(null);
  const suggestionsRef = useRef(null);
  const hasSearched = useRef(false);

  // -- Session persistence: restore on mount --
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.wasConnected) {
          setDbName(data.dbName || 'hedwig_bench');
          setCollectionName(data.collectionName || 'inbox');
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // -- Session persistence: save on connect --
  const saveSession = useCallback((db, coll) => {
    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ wasConnected: true, dbName: db, collectionName: coll })
      );
    } catch {
      // ignore
    }
  }, []);

  // -- Close suggestions when clicking outside --
  useEffect(() => {
    function handleClickOutside(e) {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(e.target)
      ) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
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
      const res = await fetch('/api/search/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mongoUri, dbName, collectionName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to connect');
      setConnected(true);
      saveSession(dbName, collectionName);
      // Check index status after connecting
      checkIndexStatus();
    } catch (err) {
      setConnectError(err.message);
    } finally {
      setConnecting(false);
    }
  }, [mongoUri, dbName, collectionName, saveSession]);

  // -- Check index status --
  const checkIndexStatus = useCallback(async () => {
    setIndexChecking(true);
    try {
      const res = await fetch('/api/search/index');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check index');
      if (data.status === 'READY' || data.status === 'ready') {
        setIndexStatus('ready');
        setConnectionOpen(false);
      } else if (data.status === 'BUILDING' || data.status === 'building' || data.status === 'PENDING' || data.status === 'pending') {
        setIndexStatus('building');
      } else if (data.exists === false || data.status === 'DOES_NOT_EXIST' || data.status === 'none') {
        setIndexStatus('none');
      } else {
        // Fallback: if exists is true, treat as ready
        setIndexStatus(data.exists ? 'ready' : 'none');
        if (data.exists) setConnectionOpen(false);
      }
    } catch {
      setIndexStatus('none');
    } finally {
      setIndexChecking(false);
    }
  }, []);

  // -- Create index --
  const handleCreateIndex = useCallback(async () => {
    setIndexCreating(true);
    try {
      const res = await fetch('/api/search/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create index');
      setIndexStatus('building');
    } catch (err) {
      setConnectError(err.message);
    } finally {
      setIndexCreating(false);
    }
  }, []);

  // -- Autocomplete --
  const fetchAutocomplete = useCallback(async (prefix) => {
    if (prefix.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    try {
      const res = await fetch('/api/search/autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix }),
      });
      const data = await res.json();
      if (res.ok && data.suggestions && data.suggestions.length > 0) {
        setSuggestions(data.suggestions);
        setShowSuggestions(true);
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    } catch {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }, []);

  // -- Debounced autocomplete on query change --
  useEffect(() => {
    if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current);
    if (query.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    autocompleteTimerRef.current = setTimeout(() => {
      fetchAutocomplete(query);
    }, 300);
    return () => {
      if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current);
    };
  }, [query, fetchAutocomplete]);

  // -- Build filters object --
  const buildFilters = useCallback(() => {
    const filters = {};
    if (filterStatus) filters.status = filterStatus;
    if (filterUserId.trim()) filters.userId = filterUserId.trim();
    if (filterDateFrom) filters.dateFrom = filterDateFrom;
    if (filterDateTo) filters.dateTo = filterDateTo;
    return filters;
  }, [filterStatus, filterUserId, filterDateFrom, filterDateTo]);

  // -- Perform search --
  const performSearch = useCallback(
    async (searchQuery, searchPage = 1) => {
      if (!searchQuery || !searchQuery.trim()) return;
      setSearching(true);
      setSearchError('');
      hasSearched.current = true;
      try {
        const res = await fetch('/api/search/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: searchQuery.trim(),
            filters: buildFilters(),
            page: searchPage,
            pageSize: PAGE_SIZE,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Search failed');
        setResults(data.results || []);
        setTotalResults(data.total || 0);
        setLatencyMs(data.latencyMs != null ? data.latencyMs : null);
        setPage(searchPage);
      } catch (err) {
        setSearchError(err.message);
        setResults([]);
        setTotalResults(0);
      } finally {
        setSearching(false);
      }
    },
    [buildFilters]
  );

  // -- Handle search submit --
  const handleSearchSubmit = useCallback(
    (e) => {
      if (e) e.preventDefault();
      setShowSuggestions(false);
      performSearch(query, 1);
    },
    [query, performSearch]
  );

  // -- Handle suggestion click --
  const handleSuggestionClick = useCallback(
    (suggestion) => {
      const text = typeof suggestion === 'string' ? suggestion : suggestion.subject || suggestion.text || '';
      setQuery(text);
      setShowSuggestions(false);
      performSearch(text, 1);
    },
    [performSearch]
  );

  // -- Clear filters --
  const handleClearFilters = useCallback(() => {
    setFilterStatus('');
    setFilterUserId('');
    setFilterDateFrom('');
    setFilterDateTo('');
  }, []);

  // -- Pagination --
  const totalPages = Math.max(1, Math.ceil(totalResults / PAGE_SIZE));

  const handlePrevPage = useCallback(() => {
    if (page > 1) performSearch(query, page - 1);
  }, [page, query, performSearch]);

  const handleNextPage = useCallback(() => {
    if (page < totalPages) performSearch(query, page + 1);
  }, [page, totalPages, query, performSearch]);

  // -- Masked URI display --
  const maskedUri = mongoUri.length > 20 ? mongoUri.slice(0, 20) + '...' : mongoUri;

  // -- Determine if search demo should be visible --
  const searchReady = connected && indexStatus === 'ready';

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-xl font-bold text-white mb-4">Atlas Search Showcase</h1>

      {/* ================================================================== */}
      {/* Connection + Index Setup                                           */}
      {/* ================================================================== */}
      <div className="bg-gray-800 rounded-lg overflow-hidden mb-6">
        <button
          type="button"
          onClick={() => setConnectionOpen((o) => !o)}
          className="w-full flex items-center justify-between px-5 py-3 text-left text-sm font-semibold text-gray-100 hover:bg-gray-700/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span>Connection &amp; Index Setup</span>
            {connected && indexStatus === 'ready' && (
              <span className="text-xs font-medium text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/30">
                Connected
              </span>
            )}
          </div>
          <ChevronIcon open={connectionOpen} />
        </button>

        {connectionOpen && (
          <div className="px-5 pb-5 pt-2 space-y-4">
            {/* MongoDB URI */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">MongoDB URI</label>
              {mongoUri && connected ? (
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
                </div>
              ) : (
                <input
                  type="text"
                  value={mongoUri}
                  onChange={(e) => setMongoUri(e.target.value)}
                  placeholder="mongodb+srv://user:pass@cluster.mongodb.net"
                  className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              )}
            </div>

            {/* DB + Collection */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Database name</label>
                <input
                  type="text"
                  value={dbName}
                  onChange={(e) => setDbName(e.target.value)}
                  disabled={connected}
                  className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Collection name</label>
                <input
                  type="text"
                  value={collectionName}
                  onChange={(e) => setCollectionName(e.target.value)}
                  disabled={connected}
                  className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent disabled:opacity-50"
                />
              </div>
            </div>

            {/* Connect button + error */}
            {!connected && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={connecting}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-md transition-colors"
                >
                  {connecting ? 'Connecting...' : 'Connect'}
                </button>
                {connectError && (
                  <span className="text-sm text-red-400">{connectError}</span>
                )}
              </div>
            )}

            {/* Reconnect prompt (from session) */}
            {!connected && !mongoUri && (
              (() => {
                try {
                  const saved = sessionStorage.getItem(SESSION_KEY);
                  if (saved && JSON.parse(saved).wasConnected) {
                    return (
                      <p className="text-sm text-gray-400">
                        You were previously connected. Enter your MongoDB URI to reconnect.
                      </p>
                    );
                  }
                } catch { /* ignore */ }
                return null;
              })()
            )}

            {/* Index status (shown after connecting) */}
            {connected && (
              <div className="flex items-center gap-3 pt-1">
                <span className="text-sm text-gray-400">Search Index:</span>

                {indexChecking && (
                  <span className="text-sm text-gray-300 animate-pulse">Checking...</span>
                )}

                {!indexChecking && indexStatus === 'ready' && (
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-400 bg-green-500/10 px-2.5 py-1 rounded-full border border-green-500/30">
                    <span className="w-2 h-2 rounded-full bg-green-400" />
                    Index Ready
                  </span>
                )}

                {!indexChecking && indexStatus === 'building' && (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-yellow-400 bg-yellow-500/10 px-2.5 py-1 rounded-full border border-yellow-500/30 animate-pulse">
                      <span className="w-2 h-2 rounded-full bg-yellow-400" />
                      Index Building...
                    </span>
                    <button
                      type="button"
                      onClick={checkIndexStatus}
                      className="p-1.5 text-gray-400 hover:text-gray-200 transition-colors rounded-md hover:bg-gray-700"
                      title="Refresh status"
                    >
                      <RefreshIcon />
                    </button>
                  </div>
                )}

                {!indexChecking && indexStatus === 'none' && (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">No search index found.</span>
                    <button
                      type="button"
                      onClick={handleCreateIndex}
                      disabled={indexCreating}
                      className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-md transition-colors"
                    >
                      {indexCreating ? 'Creating...' : 'Create Search Index'}
                    </button>
                  </div>
                )}

                {/* Disconnect action */}
                <button
                  type="button"
                  onClick={() => {
                    setConnected(false);
                    setIndexStatus(null);
                    setMongoUri('');
                    setUriVisible(false);
                    setResults(null);
                    setQuery('');
                    setSuggestions([]);
                    setConnectionOpen(true);
                    hasSearched.current = false;
                    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
                  }}
                  className="ml-auto text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            )}

            {connectError && connected && (
              <span className="text-sm text-red-400">{connectError}</span>
            )}
          </div>
        )}
      </div>

      {/* ================================================================== */}
      {/* Main content: Search Demo + Sidebar                                */}
      {/* ================================================================== */}
      {searchReady && (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* -------------------------------------------------------------- */}
          {/* Search Demo (main area)                                        */}
          {/* -------------------------------------------------------------- */}
          <div className="flex-1 min-w-0">
            {/* Search bar */}
            <form onSubmit={handleSearchSubmit} className="relative mb-4">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <SearchIcon className="w-5 h-5 text-gray-500" />
                </div>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => {
                    if (suggestions.length > 0) setShowSuggestions(true);
                  }}
                  placeholder="Search messages..."
                  className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-12 pr-24 py-3.5 text-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
                <button
                  type="submit"
                  disabled={searching || !query.trim()}
                  className="absolute inset-y-0 right-0 flex items-center px-5 text-sm font-semibold text-emerald-300 hover:text-emerald-200 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
                >
                  {searching ? 'Searching...' : 'Search'}
                </button>
              </div>

              {/* Autocomplete dropdown */}
              {showSuggestions && suggestions.length > 0 && (
                <div
                  ref={suggestionsRef}
                  className="absolute z-20 top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-lg overflow-hidden"
                >
                  {suggestions.map((suggestion, i) => {
                    const text = typeof suggestion === 'string' ? suggestion : suggestion.subject || suggestion.text || '';
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => handleSuggestionClick(suggestion)}
                        className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700/70 transition-colors border-b border-gray-700/50 last:border-b-0 flex items-center gap-3"
                      >
                        <SearchIcon className="w-4 h-4 text-gray-500 flex-shrink-0" />
                        <span className="truncate">{text}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </form>

            {/* Filter bar */}
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              >
                <option value="">All statuses</option>
                <option value="delivered">delivered</option>
                <option value="read">read</option>
                <option value="unread">unread</option>
              </select>

              <input
                type="text"
                value={filterUserId}
                onChange={(e) => setFilterUserId(e.target.value)}
                placeholder="e.g. user_000001"
                className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent w-36"
              />

              <div className="flex items-center gap-1.5 text-sm text-gray-400">
                <span>From</span>
                <input
                  type="date"
                  value={filterDateFrom}
                  onChange={(e) => setFilterDateFrom(e.target.value)}
                  className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>

              <div className="flex items-center gap-1.5 text-sm text-gray-400">
                <span>To</span>
                <input
                  type="date"
                  value={filterDateTo}
                  onChange={(e) => setFilterDateTo(e.target.value)}
                  className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>

              {(filterStatus || filterUserId || filterDateFrom || filterDateTo) && (
                <button
                  type="button"
                  onClick={handleClearFilters}
                  className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  Clear filters
                </button>
              )}
            </div>

            {/* Results area */}
            {searchError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 mb-4">
                <p className="text-sm text-red-400">{searchError}</p>
              </div>
            )}

            {/* Results header */}
            {results !== null && !searchError && (
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-gray-400">
                  <span className="text-white font-medium">{totalResults.toLocaleString()}</span>
                  {' '}result{totalResults !== 1 ? 's' : ''}
                  {latencyMs != null && (
                    <span className="text-gray-500"> in {latencyMs.toFixed(0)} ms</span>
                  )}
                </p>
                {totalPages > 1 && (
                  <p className="text-sm text-gray-500">
                    Page {page} of {totalPages}
                  </p>
                )}
              </div>
            )}

            {/* Result cards */}
            {results !== null && results.length > 0 && (
              <div className="space-y-3">
                {results.map((result, i) => {
                  const subjectHighlight = renderHighlights(result.highlights, 'subject');
                  const bodyHighlight = renderHighlights(result.highlights, 'body');

                  return (
                    <div
                      key={result._id || result.msg_id || i}
                      className="bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors p-4"
                    >
                      {/* Subject line */}
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <h3 className="text-sm font-semibold text-gray-100 leading-snug flex-1">
                          {subjectHighlight || result.subject || '(no subject)'}
                        </h3>
                        {result.score != null && (
                          <span className="text-xs text-gray-500 whitespace-nowrap flex-shrink-0">
                            relevance: {result.score.toFixed(2)}
                          </span>
                        )}
                      </div>

                      {/* Meta row */}
                      <div className="flex items-center gap-3 mb-2">
                        {result.status && <StatusBadge status={result.status} />}
                        {result.user_id && (
                          <span className="text-xs text-gray-500 font-mono">{result.user_id}</span>
                        )}
                        {result.created_at && (
                          <span className="text-xs text-gray-500">{formatDate(result.created_at)}</span>
                        )}
                      </div>

                      {/* Body snippet from highlights */}
                      {bodyHighlight && (
                        <div className="text-sm text-gray-400 leading-relaxed mt-1 line-clamp-2">
                          {bodyHighlight}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* No results state */}
            {results !== null && results.length === 0 && !searchError && (
              <div className="text-center py-12">
                <p className="text-gray-400 text-sm">
                  No results found for &lsquo;<span className="text-white">{query}</span>&rsquo;
                </p>
                <p className="text-gray-500 text-xs mt-2">
                  Try adjusting your search terms or filters.
                </p>
              </div>
            )}

            {/* Before-search empty state with suggested searches */}
            {(results === null || (results && results.length === 0 && !query)) && (
              <div className="py-12">
                <SearchIcon className="w-10 h-10 text-gray-700 mx-auto mb-4" />
                <p className="text-gray-400 text-sm text-center mb-6">
                  Search your inbox messages using Atlas Search full-text capabilities.
                </p>
                <p className="text-gray-500 text-xs text-center mb-4 uppercase tracking-wider">Suggested searches</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {[
                    { q: 'order shipped', desc: 'Full-text phrase match' },
                    { q: 'security update', desc: 'Multi-word search' },
                    { q: 'weekly digest', desc: 'Phrase matching' },
                    { q: 'rewadr', desc: 'Fuzzy match (typo for "reward")' },
                    { q: 'subscription expiring', desc: 'Cross-field relevance' },
                    { q: 'welcome', desc: 'Single-word search' },
                  ].map(({ q, desc }) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => { setQuery(q); performSearch(q, 1); }}
                      className="text-left p-3 rounded-lg bg-gray-900 border border-gray-800 hover:border-emerald-500/50 hover:bg-gray-800/80 transition-all group"
                    >
                      <span className="text-sm text-emerald-400 group-hover:text-emerald-300 font-medium">&ldquo;{q}&rdquo;</span>
                      <span className="block text-xs text-gray-500 mt-1">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Pagination */}
            {results !== null && totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 mt-6">
                <button
                  type="button"
                  onClick={handlePrevPage}
                  disabled={page <= 1}
                  className="px-4 py-2 text-sm font-medium text-gray-300 bg-gray-800 border border-gray-700 rounded-md hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-400">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={handleNextPage}
                  disabled={page >= totalPages}
                  className="px-4 py-2 text-sm font-medium text-gray-300 bg-gray-800 border border-gray-700 rounded-md hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            )}
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Sidebar: Capabilities Showcase                                  */}
          {/* -------------------------------------------------------------- */}
          <aside className="w-full lg:w-72 flex-shrink-0">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              What&rsquo;s being demonstrated
            </h2>
            <div className="space-y-3">
              {CAPABILITIES.map((cap) => (
                <CapabilityCard key={cap.title} title={cap.title} description={cap.description} />
              ))}
            </div>
          </aside>
        </div>
      )}

      {/* ================================================================== */}
      {/* Pre-connection state                                               */}
      {/* ================================================================== */}
      {!searchReady && !connectionOpen && (
        <div className="text-center py-16">
          <p className="text-gray-400 text-sm">
            {connected && indexStatus === 'building'
              ? 'Waiting for the Atlas Search index to finish building. Check back in a moment.'
              : connected && indexStatus === 'none'
                ? 'Create a search index to get started.'
                : 'Connect to your MongoDB Atlas cluster to explore Atlas Search.'}
          </p>
          <button
            type="button"
            onClick={() => setConnectionOpen(true)}
            className="mt-3 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            Open connection settings
          </button>
        </div>
      )}
    </div>
  );
}
