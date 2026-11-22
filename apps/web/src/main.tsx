import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { initPwa } from '@/lib/pwa';
import '@/index.css';

initPwa();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root is missing');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
