import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

createRoot(document.getElementById('root')!).render(<App />);

// New versions wait until old tabs close. No skipWaiting/clients.claim forced cutover.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      window.dispatchEvent(new Event('focus-timer-offline-ready'));
    }).catch(() => {
      // Local use is still available; offline readiness is reported by the worker only after caching.
      window.dispatchEvent(new Event('focus-timer-offline-unavailable'));
    });
  });
}
