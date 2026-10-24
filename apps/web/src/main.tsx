import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';

const AdminApp = lazy(() => import('./AdminApp'));
const Page = window.location.pathname.startsWith('/admin') ? AdminApp : App;
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Suspense fallback={<div className="grid min-h-screen place-items-center bg-[#f3f6f2] text-sm text-[#65746b]">Loading manager tools…</div>}><Page /></Suspense></React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('Offline app shell is unavailable:', error);
    });
  });
}
