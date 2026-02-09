import React from 'react';
import ReactDOM from 'react-dom/client';
import { installExtensionBridge } from './extensionBridge';
import App from './App';

// Install polyfills before React mounts — provides window.ai/window.agent
// when running inside the Chrome extension (no-op when Harbor is present).
installExtensionBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
