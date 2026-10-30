import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import 'katex/dist/katex.min.css';
import './styles.css';
import './lib/monaco';
import ClientPage from './pages/Client';
import AdminPage from './pages/Admin';
import ScoreboardPage from './pages/Scoreboard';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/admin/*" element={<AdminPage />} />
        <Route path="/scoreboard" element={<ScoreboardPage />} />
        <Route path="*" element={<ClientPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
