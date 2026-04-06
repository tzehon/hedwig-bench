import { Link, Outlet, useLocation } from 'react-router-dom';

const navItems = [
  { path: '/', label: 'Configure & Run' },
  { path: '/history', label: 'Run History' },
  { path: '/search', label: 'Atlas Search' },
  { path: '/queries', label: 'Query Demo' },
];

export default function App() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-gray-950">
      <nav className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-6">
              <Link to="/" className="text-lg font-bold text-white tracking-tight">
                Hedwig<span className="text-indigo-400">Bench</span>
              </Link>
              <div className="flex gap-1">
                {navItems.map(({ path, label }) => (
                  <Link
                    key={path}
                    to={path}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      location.pathname === path
                        ? 'bg-indigo-500/20 text-indigo-300'
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
