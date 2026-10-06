import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { Toaster } from '@/components/ui/toast';
import './index.css';

// A crash shows what broke instead of a blank page, so it can be fixed in the IDE or by the coding agent.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-xl border border-destructive/50 bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-destructive">Something in the app crashed</h1>
          <p className="mt-1 text-sm text-muted-foreground">Open the IDE and ask the coding agent to fix this error:</p>
          <pre className="mt-4 overflow-x-auto rounded-md bg-muted p-3 text-xs">{String(this.state.error && this.state.error.message)}</pre>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
    <Toaster />
  </ErrorBoundary>
);
