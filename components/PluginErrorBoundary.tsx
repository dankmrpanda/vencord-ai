/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';

export interface PluginLogEntry {
  time: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  logs: PluginLogEntry[];
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
  errorInfo: any;
}

let CachedErrorBoundary: any = null;

export function getPluginErrorBoundary(): any {
  if (CachedErrorBoundary) return CachedErrorBoundary;

  const BaseComponent: any = React?.Component || class {};

  CachedErrorBoundary = class PluginErrorBoundary extends BaseComponent {
    state: ErrorBoundaryState = { hasError: false, error: null, errorInfo: null };

    static getDerivedStateFromError(error: any) {
      return { hasError: true, error };
    }

    componentDidCatch(error: any, errorInfo: any) {
      console.error('[VencordAI] ErrorBoundary caught error:', error?.stack || error?.message || error);
      this.setState({ errorInfo });
    }

    render() {
      const state = this.state as ErrorBoundaryState;
      const props = this.props as ErrorBoundaryProps;

      if (state.hasError) {
        return (
          <div
            style={{
              padding: '20px',
              color: 'var(--text-normal, #dbdee1)',
              fontFamily: 'var(--font-primary, sans-serif)',
              display: 'flex',
              flexDirection: 'column',
              height: '100vh',
              boxSizing: 'border-box',
              overflowY: 'auto',
              backgroundColor: 'var(--background-primary, #313338)',
            }}
          >
            <div style={{ fontSize: '36px', textAlign: 'center', marginBottom: '8px' }}>⚠️</div>
            <div
              style={{
                fontWeight: 700,
                fontSize: '16px',
                color: 'var(--header-primary, #f2f3f5)',
                textAlign: 'center',
                marginBottom: '8px',
              }}
            >
              AI Assistant Render Error
            </div>
            <div
              style={{
                fontSize: '12px',
                color: '#f23f43',
                marginBottom: '12px',
                wordBreak: 'break-word',
                backgroundColor: 'var(--background-secondary, #2b2d31)',
                padding: '10px 12px',
                borderRadius: '6px',
                border: '1px solid var(--background-modifier-accent, #3f4147)',
                fontFamily: 'monospace',
              }}
            >
              {String(state.error?.stack || state.error?.message || state.error || 'Unknown render error')}
            </div>
            {state.errorInfo?.componentStack && (
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--text-muted, #949ba4)',
                  marginBottom: '12px',
                  backgroundColor: 'var(--background-secondary-alt, #232428)',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  fontFamily: 'monospace',
                  maxHeight: '120px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {'Component Stack:\n' + state.errorInfo.componentStack}
              </div>
            )}
            <button
              style={{
                padding: '10px 16px',
                backgroundColor: 'var(--brand-experiment, #5865f2)',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '13px',
                marginBottom: '16px',
              }}
              onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
            >
              🔄 Retry Component Render
            </button>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--header-secondary, #b5bac1)', marginBottom: '6px' }}>
              Recent Plugin Logs:
            </div>
            <div
              style={{
                flex: 1,
                backgroundColor: 'var(--background-secondary, #2b2d31)',
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: '11px',
                fontFamily: 'monospace',
                overflowY: 'auto',
                border: '1px solid var(--background-modifier-accent, #3f4147)',
              }}
            >
              {(props.logs || []).map((l, i) => (
                <div
                  key={i}
                  style={{
                    color: l.level === 'error' ? '#f23f43' : l.level === 'warn' ? '#f0b232' : '#949ba4',
                    marginBottom: '3px',
                    wordBreak: 'break-word',
                  }}
                >
                  {`[${l.time}] ${l.message}`}
                </div>
              ))}
            </div>
          </div>
        );
      }
      return props.children;
    }
  };

  return CachedErrorBoundary;
}
