import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App';
import ConfigPage from './pages/ConfigPage';
import LiveDashboard from './pages/LiveDashboard';
import ResultsPage from './pages/ResultsPage';
import HistoryPage from './pages/HistoryPage';
import SearchPage from './pages/SearchPage';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<ConfigPage />} />
          <Route path="run/:id" element={<LiveDashboard />} />
          <Route path="results/:id" element={<ResultsPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="search" element={<SearchPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
