import { Link, Outlet, useLocation } from 'react-router-dom';

const navItems = [
  { path: '/', label: 'Configure & Run' },
  { path: '/history', label: 'Run History' },
  { path: '/search', label: 'Atlas Search' },
  { path: '/queries', label: 'Query Demo' },
  { path: '/loader', label: 'Data Loader' },
];

export default function App() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-gray-950">
      <nav className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-6">
              <Link to="/" className="flex items-center gap-2 text-lg font-bold text-white tracking-tight">
                <svg className="w-6 h-6" viewBox="0 0 64 64" fill="none">
                  <path d="M34.6 11.2c-.7-1.4-1.4-2.1-1.7-3.1-.4-.3-.4-.7-.7-1.1 0 .4-.3.7-.7 1.1-.3 1-1 1.7-1.7 3.1-7.1 7.8-14.9 11.3-14.9 24.2 0 6.4 4.2 12 10.6 14.2l.7.3c.3-1 .3-2.1.3-3.1 0-2.1-.7-3.5-1.7-5.2-1-1.4-2.1-3.1-2.4-5.9 0 0 1.7 2.1 4.2 3.1-.3-1-.3-2.1-.3-3.1 0-3.1 1-5.9 2.8-8.3.3 1.7 1.4 3.1 2.4 4.5 1 1.4 2.1 2.8 2.4 4.9.3-1 .3-2.4.3-3.5 2.8 3.8 3.5 7.3 3.5 10.4 0 1 0 2.1.3 3.1l.7-.3c6.4-2.1 10.6-7.8 10.6-14.2-.4-12.9-8.2-16.4-14.7-21.1z" fill="#00ED64"/>
                </svg>
                Hedwig<span className="text-emerald-400">Bench</span>
              </Link>
              <div className="flex gap-1">
                {navItems.map(({ path, label }) => (
                  <Link
                    key={path}
                    to={path}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      location.pathname === path
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                    }`}
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </div>
            <div className="text-xs text-gray-500">
              MongoDB Atlas Inbox Workload Benchmark
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
    </div>
  );
}
