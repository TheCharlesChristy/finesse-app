import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Self-hosted rather than fetched from Google Fonts: a font request is a
// network call at runtime, which this app does not otherwise make, and it
// leaves the first paint of an offline launch without a typeface.
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/dm-serif-display/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';

import './pwa';
import './index.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
