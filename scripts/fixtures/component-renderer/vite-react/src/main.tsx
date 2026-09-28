import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@fixture/App';
import '@fixture/styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);
