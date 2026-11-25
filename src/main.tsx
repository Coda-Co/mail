import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { restorePaneWidths } from './components/Resizer';

restorePaneWidths();

// A file dropped anywhere but a draft would otherwise make the web view open it in place of
// the app. Drafts handle their own drops (and stop them reaching here).
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      if (type === 'dragover') e.dataTransfer.dropEffect = 'none';
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
