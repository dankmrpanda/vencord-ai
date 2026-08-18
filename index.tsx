/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from '@utils/types';
import { React } from '@webpack/common';
import { SidebarPanel } from './components/SidebarPanel';
import { findByProps } from './discord/stores';
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

let LazyErrorBoundary: any = null;
function getErrorBoundary() {
  if (LazyErrorBoundary) return LazyErrorBoundary;
  const ReactMod = (window as any).React || (window as any).Vencord?.Webpack?.Common?.React || React;
  if (!ReactMod?.Component) return null;

  LazyErrorBoundary = class extends ReactMod.Component<any, { hasError: boolean; error: any }> {
    constructor(props: any) {
      super(props);
      this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error: any) {
      return { hasError: true, error };
    }
    componentDidCatch(error: any, info: any) {
      console.error('[VencordAI] Error in SidebarPanel:', error, info);
    }
    render() {
      if (this.state.hasError) {
        return ReactMod.createElement(
          'div',
          {
            style: {
              padding: '24px',
              color: 'var(--text-normal, #dbdee1)',
              fontFamily: 'inherit',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              textAlign: 'center',
              backgroundColor: 'var(--background-primary, #313338)',
            },
          },
          ReactMod.createElement('div', { style: { fontSize: '36px', marginBottom: '12px' } }, '⚠️'),
          ReactMod.createElement(
            'div',
            {
              style: {
                fontWeight: 600,
                fontSize: '15px',
                color: 'var(--header-primary, #f2f3f5)',
                marginBottom: '8px',
              },
            },
            'AI Assistant Render Error'
          ),
          ReactMod.createElement(
            'div',
            {
              style: {
                fontSize: '12px',
                color: 'var(--text-muted, #949ba4)',
                marginBottom: '16px',
                maxWidth: '320px',
                wordBreak: 'break-word',
                backgroundColor: 'var(--background-secondary, #2b2d31)',
                padding: '10px 12px',
                borderRadius: '6px',
                border: '1px solid var(--background-modifier-accent, #3f4147)',
              },
            },
            String(this.state.error?.message || this.state.error || 'Unknown error')
          ),
          ReactMod.createElement(
            'button',
            {
              style: {
                padding: '8px 16px',
                backgroundColor: 'var(--brand-experiment, #5865f2)',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '12px',
              },
              onClick: () => this.setState({ hasError: false, error: null }),
            },
            '🔄 Retry'
          )
        );
      }
      return this.props.children;
    }
  };
  return LazyErrorBoundary;
}

function getReactDOM(): any {
  if (typeof window !== 'undefined') {
    const vcWp = (window as any).Vencord?.Webpack;
    if (vcWp?.Common?.ReactDOM) return vcWp.Common.ReactDOM;
    if (vcWp?.findByProps) {
      try {
        const cr = vcWp.findByProps('createRoot');
        if (cr?.createRoot) return cr;
      } catch {}
      try {
        const ren = vcWp.findByProps('render', 'unmountComponentAtNode') || vcWp.findByProps('render');
        if (ren?.render) return ren;
      } catch {}
    }
    if ((window as any).ReactDOM) return (window as any).ReactDOM;
  }
  const createRootMod = findByProps('createRoot');
  if (createRootMod?.createRoot) return createRootMod;
  const renderMod = findByProps('render', 'unmountComponentAtNode') || findByProps('render');
  if (renderMod?.render) return renderMod;
  return null;
}

function renderSidebar() {
  try {
    const dom = getReactDOM();

    if (!rootContainer) {
      rootContainer = document.createElement('div');
      rootContainer.id = 'vencord-ai-sidebar-root';
      document.body.appendChild(rootContainer);
    }

    if (!reactRoot && dom?.createRoot) {
      try {
        reactRoot = dom.createRoot(rootContainer);
      } catch (err) {
        console.error('[VencordAI] Error creating React root:', err);
      }
    }

    if (!isSidebarOpen) {
      rootContainer.style.display = 'none';
      return;
    }

    rootContainer.style.display = 'flex';

    const EB = getErrorBoundary();
    const panel = (
      <SidebarPanel
        settings={currentSettings}
        onClose={() => {
          isSidebarOpen = false;
          renderSidebar();
        }}
      />
    );
    const element = EB ? <EB>{panel}</EB> : panel;

    if (reactRoot?.render) {
      reactRoot.render(element);
    } else if (dom?.render) {
      dom.render(element, rootContainer);
    } else {
      console.error('[VencordAI] No ReactDOM render method found to mount sidebar');
    }
  } catch (err) {
    console.error('[VencordAI] Error rendering sidebar:', err);
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

    const dom = getReactDOM();
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
