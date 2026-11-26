import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { reportError } from './api.js';

// Erros fora dos componentes (eventos, promessas) também vão para data/erros-interface.log.
window.addEventListener('error', (e) => reportError(e.error || e.message, 'janela'));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'promessa'));

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
