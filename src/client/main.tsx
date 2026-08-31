import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { useStore } from './store';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

createRoot(root).render(
  <StrictMode>
    {/*
      Outside App rather than inside it: a boundary only catches what is below
      it, and the lobby is as capable of throwing as the board is.
    */}
    <ErrorBoundary onReset={() => useStore.getState().detach()}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
