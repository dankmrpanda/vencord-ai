/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from '@utils/types';
import { createRoot as vcCreateRoot, React } from '@webpack/common';
import { SidebarPanel } from './components/SidebarPanel';
import { find, findByCode, findByProps } from './discord/stores';
import {
  DEFAULT_SETTINGS,
  loadSavedSettings,
  persistSettings,
  settings,
  SettingsPanel,
} from './settings';
import { PluginSettings } from './types';

let rootContainer: HTMLDivElement | null = null;
let reactRoot: any = null;
let isSidebarOpen = false;
let currentSettings: PluginSettings = { ...DEFAULT_SETTINGS };
let headerPollInterval: any = null;
let headerInjectionTimeout: any = null;
let stylesheetInjected = false;

function injectPluginStyles() {
  if (stylesheetInjected || document.getElementById('vencord-ai-styles')) return;
  const style = document.createElement('style');
  style.id = 'vencord-ai-styles';
  style.textContent = `
    @keyframes vencord-ai-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    @keyframes vencord-ai-slide-in {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes vencord-ai-tooltip-appear {
      from {
        opacity: 0;
        transform: translate(-50%, -4px);
      }
      to {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    }

    #vencord-ai-header-btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      margin: 0 4px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 16px;
      user-select: none;
      color: var(--interactive-normal, #b5bac1);
      transition: color 0.15s ease, background-color 0.15s ease, transform 0.15s ease;
      flex-shrink: 0;
    }
    #vencord-ai-header-btn:hover {
      color: var(--interactive-hover, #dbdee1);
      background-color: var(--background-modifier-hover, rgba(255, 255, 255, 0.08));
    }
    #vencord-ai-header-btn:active {
      color: var(--interactive-active, #ffffff);
      background-color: var(--background-modifier-active, rgba(255, 255, 255, 0.16));
    }

    /* Native Discord-style Tooltip matching Image 3 */
    #vencord-ai-header-btn[data-tooltip]:hover::before {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background-color: var(--background-floating, #111214);
      color: var(--text-normal, #dbdee1);
      padding: 6px 10px;
      border-radius: 5px;
      font-size: 14px;
      font-weight: 600;
      font-family: var(--font-primary, "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif);
      white-space: nowrap;
      box-shadow: var(--elevation-high, 0 8px 16px rgba(0, 0, 0, 0.4));
      z-index: 100001;
      pointer-events: none;
      border: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.08));
      animation: vencord-ai-tooltip-appear 0.12s ease-out;
    }
    #vencord-ai-header-btn[data-tooltip]:hover::after {
      content: '';
      position: absolute;
      top: calc(100% + 3px);
      left: 50%;
      transform: translateX(-50%);
      border-width: 0 5px 5px 5px;
      border-style: solid;
      border-color: transparent transparent var(--background-floating, #111214) transparent;
      z-index: 100001;
      pointer-events: none;
      animation: vencord-ai-tooltip-appear 0.12s ease-out;
    }

    #vencord-ai-sidebar-root {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 400px;
      max-width: 95vw;
      height: 100vh;
      box-sizing: border-box;
      z-index: 100000;
      box-shadow: -6px 0 24px rgba(0, 0, 0, 0.55);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      animation: vencord-ai-slide-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      background-color: var(--background-primary, #313338);
      font-family: var(--font-primary, "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif);
    }

    #vencord-ai-sidebar-root ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    #vencord-ai-sidebar-root ::-webkit-scrollbar-thumb {
      background-color: var(--background-tertiary, #1e1f22);
      border-radius: 3px;
    }
    #vencord-ai-sidebar-root ::-webkit-scrollbar-thumb:hover {
      background-color: var(--background-modifier-hover, #3f4147);
    }
  `;
  document.head.appendChild(style);
  stylesheetInjected = true;
}

const pluginLogs: Array<{ time: string; level: 'info' | 'warn' | 'error'; message: string }> = [];

export function logPlugin(level: 'info' | 'warn' | 'error', message: string, ...args: any[]) {
  const time = new Date().toLocaleTimeString();
  const fullMsg = `${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`.trim();
  pluginLogs.push({ time, level, message: fullMsg });
  if (pluginLogs.length > 60) pluginLogs.shift();
  if (level === 'error') console.error(`[VencordAI] ${message}`, ...args);
  else if (level === 'warn') console.warn(`[VencordAI] ${message}`, ...args);
  else console.log(`[VencordAI] ${message}`, ...args);
}

class PluginErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: any; errorInfo: any }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    logPlugin('error', 'ErrorBoundary caught error:', error?.stack || error?.message || error);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
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
            {String(this.state.error?.stack || this.state.error?.message || this.state.error || 'Unknown render error')}
          </div>
          {this.state.errorInfo?.componentStack && (
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
              {'Component Stack:\n' + this.state.errorInfo.componentStack}
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
            {pluginLogs.map((l, i) => (
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
    return this.props.children;
  }
}

/**
 * Finds React 18's createRoot function using Vencord's own resolution pattern.
 * Vencord source: createRoot = findByCodeLazy("(299));", ".onRecoverableError")
 */
function findCreateRoot(): ((container: Element | DocumentFragment) => { render(children: any): void; unmount(): void }) | null {
  // Method 1: Direct export from @webpack/common
  if (typeof vcCreateRoot === 'function') {
    return vcCreateRoot;
  }

  // Method 2: Check window.Vencord.Webpack.Common.createRoot
  if (typeof window !== 'undefined') {
    const vcCommon = (window as any).Vencord?.Webpack?.Common;
    if (typeof vcCommon?.createRoot === 'function') return vcCommon.createRoot;
  }

  // Method 3: Vencord's exact pattern: findByCode("(299));", ".onRecoverableError")
  try {
    const byCode = findByCode('(299));', '.onRecoverableError') || findByCode('.onRecoverableError');
    if (typeof byCode === 'function') return byCode;
    if (typeof byCode?.createRoot === 'function') return byCode.createRoot;
    if (typeof byCode?.default?.createRoot === 'function') return byCode.default.createRoot;
    if (typeof byCode?.default === 'function') return byCode.default;
  } catch {}

  // Method 4: findByProps for the react-dom/client chunk
  try {
    const clientMod = findByProps('createRoot', 'hydrateRoot') || findByProps('createRoot');
    if (typeof clientMod?.createRoot === 'function') return clientMod.createRoot;
    if (typeof clientMod?.default?.createRoot === 'function') return clientMod.default.createRoot;
    if (typeof clientMod === 'function') return clientMod;
  } catch {}

  // Method 5: Global window.ReactDOM
  if (typeof window !== 'undefined') {
    const rdom = (window as any).ReactDOM;
    if (typeof rdom?.createRoot === 'function') return rdom.createRoot;
  }

  // Method 6: Broad search in Webpack modules
  try {
    const found = find((m: any) => {
      if (!m) return false;
      return (
        typeof m.createRoot === 'function' ||
        typeof m.default?.createRoot === 'function' ||
        (typeof m === 'function' && m.toString().includes('onRecoverableError'))
      );
    });
    if (typeof found?.createRoot === 'function') return found.createRoot;
    if (typeof found?.default?.createRoot === 'function') return found.default.createRoot;
    if (typeof found === 'function') return found;
  } catch {}

  return null;
}

/**
 * Gets a legacy ReactDOM module (with render/unmountComponentAtNode/createPortal).
 * Vencord source: ReactDOM = findByPropsLazy("createPortal")
 */
function getLegacyReactDOM(): any {
  // Method 1: window.ReactDOM
  if (typeof window !== 'undefined' && (window as any).ReactDOM) {
    return (window as any).ReactDOM;
  }

  // Method 2: Vencord Webpack Common ReactDOM
  if (typeof window !== 'undefined') {
    const vcRDOM = (window as any).Vencord?.Webpack?.Common?.ReactDOM;
    if (vcRDOM) {
      const actual = vcRDOM.default || vcRDOM;
      if (typeof actual.render === 'function' || typeof actual.createPortal === 'function') return actual;
    }
  }

  // Method 3: findByProps with render + unmountComponentAtNode
  try {
    const mod = findByProps('render', 'unmountComponentAtNode') || findByProps('createPortal');
    if (mod?.render) return mod;
    if (mod?.default?.render) return mod.default;
  } catch {}

  return null;
}

function renderSidebar() {
  try {
    injectPluginStyles();
    logPlugin('info', `renderSidebar invoked. isSidebarOpen = ${isSidebarOpen}`);

    if (!rootContainer) {
      rootContainer = document.createElement('div');
      rootContainer.id = 'vencord-ai-sidebar-root';
      document.body.appendChild(rootContainer);
      logPlugin('info', 'Created and appended #vencord-ai-sidebar-root to document.body');
    }

    if (!isSidebarOpen) {
      rootContainer.style.display = 'none';
      return;
    }

    rootContainer.style.display = 'flex';

    const panel = (
      <SidebarPanel
        settings={currentSettings}
        onClose={() => {
          isSidebarOpen = false;
          renderSidebar();
        }}
        logs={pluginLogs}
      />
    );
    const element = <PluginErrorBoundary>{panel}</PluginErrorBoundary>;

    // Attempt 1: If we already have a functional reactRoot, re-render into it
    if (reactRoot?.render) {
      try {
        reactRoot.render(element);
        logPlugin('info', 'Mounted component via existing reactRoot.render');
        return;
      } catch (err: any) {
        logPlugin('warn', `Existing reactRoot.render failed: ${err?.message || err}`);
        reactRoot = null;
      }
    }

    // Attempt 2: Try createRoot (React 18+)
    const createRootFn = findCreateRoot();
    logPlugin('info', `findCreateRoot resolved: ${createRootFn ? 'found' : 'null'}`);

    if (createRootFn) {
      try {
        if (!reactRoot) {
          reactRoot = createRootFn(rootContainer);
        }
        reactRoot.render(element);
        logPlugin('info', 'Mounted component via createRoot');
        return;
      } catch (err: any) {
        logPlugin('warn', `createRoot failed: ${err?.message || err}`);
        reactRoot = null;
      }
    }

    // Attempt 3: Legacy ReactDOM.render fallback
    const legacyDom = getLegacyReactDOM();
    logPlugin('info', `getLegacyReactDOM resolved: ${legacyDom ? 'found' : 'null'}`);

    if (legacyDom?.render) {
      try {
        legacyDom.render(element, rootContainer);
        logPlugin('info', 'Mounted component via legacy ReactDOM.render');
        return;
      } catch (err: any) {
        logPlugin('warn', `Legacy ReactDOM.render failed: ${err?.message || err}`);
      }
    }

    // All React render methods failed — show diagnostic HTML fallback
    logPlugin('error', 'All ReactDOM render methods failed. Showing HTML fallback.');
    const logsHtml = pluginLogs
      .map(
        (l) =>
          `<div style="color: ${l.level === 'error' ? '#f23f43' : l.level === 'warn' ? '#f0b232' : '#949ba4'}; margin-bottom: 3px;">[${l.time}] ${l.message}</div>`
      )
      .join('');

    rootContainer.innerHTML = `
      <div style="padding: 20px; color: var(--text-normal, #dbdee1); background-color: var(--background-primary, #313338); height: 100vh; box-sizing: border-box; overflow-y: auto; font-family: var(--font-primary, sans-serif); display: flex; flex-direction: column;">
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="font-size: 36px; margin-bottom: 8px;">⚠️</div>
          <div style="font-weight: 700; font-size: 16px; color: var(--header-primary, #f2f3f5); margin-bottom: 4px;">AI Assistant Mounting Error</div>
          <div style="font-size: 12px; color: var(--text-danger, #f23f43); margin-bottom: 12px;">Could not initialize the React renderer.</div>
        </div>
        <button id="vencord-ai-retry-mount-btn" style="padding: 10px; background-color: var(--brand-experiment, #5865f2); color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 13px; margin-bottom: 16px;">🔄 Retry Mount</button>
        <div style="font-size: 12px; font-weight: 600; color: var(--header-secondary, #b5bac1); margin-bottom: 6px;">Live Diagnostic Logs:</div>
        <div style="flex: 1; background-color: var(--background-secondary, #2b2d31); border: 1px solid var(--background-modifier-accent, #3f4147); border-radius: 6px; padding: 10px; font-family: monospace; font-size: 11px; overflow-y: auto; max-height: 400px; white-space: pre-wrap;">
          ${logsHtml || 'No logs recorded.'}
        </div>
      </div>
    `;
    const retryBtn = rootContainer.querySelector('#vencord-ai-retry-mount-btn');
    retryBtn?.addEventListener('click', () => {
      if (reactRoot?.unmount) {
        try { reactRoot.unmount(); } catch {}
      }
      reactRoot = null;
      if (rootContainer) {
        rootContainer.remove();
        rootContainer = null;
      }
      renderSidebar();
    });
  } catch (err: any) {
    logPlugin('error', `Fatal error in renderSidebar: ${err?.stack || err?.message || err}`);
  }
}

export function toggleAIAssistant() {
  isSidebarOpen = !isSidebarOpen;
  renderSidebar();
}

if (typeof window !== 'undefined') {
  (window as any).toggleVencordAIAssistant = toggleAIAssistant;
}

function injectHeaderButton() {
  try {
    injectPluginStyles();

    const existingBtn = document.getElementById('vencord-ai-header-btn');
    if (existingBtn && existingBtn.isConnected) return;

    const toolbars = document.querySelectorAll(
      'section[class*="title_"] [class*="toolbar_"], [class*="upperContainer_"] [class*="toolbar_"], [class*="toolbar__"]'
    );
    if (!toolbars || toolbars.length === 0) return;

    const toolbar = toolbars[0];
    if (toolbar.querySelector('#vencord-ai-header-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'vencord-ai-header-btn';
    btn.setAttribute('data-tooltip', 'AI Assistant (Cmd+Shift+A)');
    btn.setAttribute('aria-label', 'AI Message Assistant');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerText = '✨';

    const handleClick = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      toggleAIAssistant();
    };

    btn.addEventListener('click', handleClick);
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleAIAssistant();
      }
    });

    toolbar.prepend(btn);
  } catch (err) {
    // Non-fatal
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
    e.preventDefault();
    toggleAIAssistant();
  } else if (e.key === 'Escape' && isSidebarOpen) {
    e.preventDefault();
    toggleAIAssistant();
  }
}

export function startPlugin() {
  try {
    currentSettings = loadSavedSettings();
    window.addEventListener('keydown', handleKeyDown);

    headerInjectionTimeout = setTimeout(injectHeaderButton, 500);
    headerPollInterval = setInterval(injectHeaderButton, 1000);

    console.log('[VencordAI] AI Assistant Plugin started successfully.');
  } catch (err) {
    console.error('[VencordAI] Error starting plugin:', err);
  }
}

export function stopPlugin() {
  try {
    window.removeEventListener('keydown', handleKeyDown);
    if (headerInjectionTimeout) {
      clearTimeout(headerInjectionTimeout);
      headerInjectionTimeout = null;
    }
    if (headerPollInterval) {
      clearInterval(headerPollInterval);
      headerPollInterval = null;
    }

    const btn = document.getElementById('vencord-ai-header-btn');
    btn?.remove();

    const styles = document.getElementById('vencord-ai-styles');
    styles?.remove();
    stylesheetInjected = false;

    const dom = getLegacyReactDOM();
    if (reactRoot?.unmount) {
      reactRoot.unmount();
      reactRoot = null;
    } else if (dom?.unmountComponentAtNode && rootContainer) {
      dom.unmountComponentAtNode(rootContainer);
    }

    rootContainer?.remove();
    rootContainer = null;
    isSidebarOpen = false;

    console.log('[VencordAI] AI Assistant Plugin stopped.');
  } catch (err) {
    console.error('[VencordAI] Error stopping plugin:', err);
  }
}

export default definePlugin({
  name: 'AIAssistant',
  description:
    'Client-side AI assistant to query 100k+ messages and images across channels & DMs with local (omlx, Ollama) and cloud LLMs.',
  authors: [{ name: 'Raymond' }],
  settings,
  settingsAboutComponent: () => (
    <SettingsPanel
      settings={currentSettings}
      onChange={(newSettings) => {
        persistSettings(newSettings);
        currentSettings = newSettings;
        renderSidebar();
      }}
    />
  ),
  start: startPlugin,
  stop: stopPlugin,
});
