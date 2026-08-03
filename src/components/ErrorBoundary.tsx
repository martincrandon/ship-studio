import { Component, ReactNode } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { logger } from '../lib/logger';
import { lookupBlobOwner, markPluginCrashed } from '../lib/plugin-loader';
import { uninstallPlugin } from '../lib/plugins';
import { Button } from './primitives/Button';
import { InfoIcon } from './icons';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.logError(error, { componentStack: errorInfo.componentStack ?? undefined });

    // Auto-remove crashing plugins so they don't crash again on Continue
    const stack = error.stack ?? '';
    const blobMatch = /blob:[^\s:)]+/.exec(stack);
    if (blobMatch) {
      const owner = lookupBlobOwner(blobMatch[0]);
      if (owner) {
        markPluginCrashed(owner.pluginId);
        void uninstallPlugin(owner.projectPath, owner.pluginId).catch((e) =>
          console.error(`Failed to auto-remove plugin "${owner.pluginId}":`, e)
        );
      }
    }
  }

  /** Check if the error likely originated from a plugin */
  private isPluginError(): boolean {
    const msg = this.state.error?.message ?? '';
    const stack = this.state.error?.stack ?? '';
    return (
      msg.includes('Plugin context') ||
      msg.includes('plugin-sdk') ||
      stack.includes('blob:') ||
      stack.includes('usePluginContext')
    );
  }

  handleContinue = () => {
    this.setState({ hasError: false, error: null });
  };

  handleRestart = async () => {
    try {
      await relaunch();
    } catch (err) {
      // In dev mode, relaunch might not work - try window reload
      logger.error('Relaunch failed, trying reload', {
        error: err instanceof Error ? err.message : String(err),
      });
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            backgroundColor: '#141414',
            color: '#bcbcbc',
            fontFamily: 'var(--font-ui)',
            padding: '20px',
            textAlign: 'center',
          }}
        >
          <div style={{ marginBottom: '24px', color: 'var(--accent-error)' }}>
            <InfoIcon size={48} />
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, margin: '0 0 8px 0' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '14px', color: '#888', margin: '0 0 24px 0', maxWidth: '400px' }}>
            {this.isPluginError()
              ? 'A plugin crashed. You can continue without it or restart the app.'
              : this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            {this.isPluginError() && (
              <Button variant="primary" onClick={this.handleContinue}>
                Continue
              </Button>
            )}
            <Button
              variant={this.isPluginError() ? 'secondary' : 'primary'}
              onClick={() => void this.handleRestart()}
            >
              Restart App
            </Button>
          </div>
          {this.state.error && (
            <details
              style={{
                marginTop: '24px',
                fontSize: '12px',
                color: '#666',
                maxWidth: '500px',
                textAlign: 'left',
              }}
            >
              <summary style={{ cursor: 'pointer', marginBottom: '8px' }}>
                Technical details
              </summary>
              <pre
                style={{
                  backgroundColor: '#2a2a2a',
                  padding: '12px',
                  borderRadius: '4px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {this.state.error.stack || this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
