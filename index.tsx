import definePlugin from '@utils/types';
import { React, ReactDOM } from '@webpack/common';
import { SidebarPanel } from './components/SidebarPanel';
import { findByProps } from './discord/stores';
import {
  DEFAULT_SETTINGS,
  loadSavedSettings,
  persistSettings,
  pluginSettings,
  SettingsPanel,
} from './settings';
import { PluginSettings } from './types';

let rootContainer: HTMLDivElement | null = null;
let reactRoot: any = null;
let isSidebarOpen = false;
let currentSettings: PluginSettings = { ...DEFAULT_SETTINGS };
let headerPollInterval: any = null;
let headerInjectionTimeout: any = null;
let tooltipStyleInjected = false;

function injectTooltipStyles() {
  if (tooltipStyleInjected || document.getElementById('vencord-ai-styles')) return;
  const style = document.createElement('style');
  style.id = 'vencord-ai-styles';
  style.textContent = `
    #vencord-ai-header-btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      margin: 0 4px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 17px;
      user-select: none;
      color: var(--interactive-normal, #b5bac1);
      transition: color 0.15s ease, background-color 0.15s ease, transform 0.15s ease;
    }
    #vencord-ai-header-btn:hover {
      color: var(--interactive-hover, #dbdee1);
      background-color: var(--background-modifier-hover, rgba(255, 255, 255, 0.07));
      transform: scale(1.1);
    }
    #vencord-ai-header-btn:active {
      color: var(--interactive-active, #ffffff);
      background-color: var(--background-modifier-active, rgba(255, 255, 255, 0.14));
      transform: scale(0.95);
    }
    #vencord-ai-header-btn[data-tooltip]:hover::before {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 8px);
      right: 50%;
      transform: translateX(50%);
      background-color: var(--background-floating, #111214);
      color: var(--text-normal, #dbdee1);
      padding: 6px 10px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
      z-index: 100000;
      pointer-events: none;
      border: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.08));
    }
    #vencord-ai-header-btn[data-tooltip]:hover::after {
      content: '';
      position: absolute;
      top: calc(100% + 2px);
      right: 50%;
      transform: translateX(50%);
      border-width: 0 5px 6px 5px;
      border-style: solid;
      border-color: transparent transparent var(--background-floating, #111214) transparent;
      z-index: 100000;
      pointer-events: none;
    }
    #vencord-ai-sidebar-root {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 380px;
      z-index: 10000;
      box-shadow: -4px 0 20px rgba(0, 0, 0, 0.45);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);
  tooltipStyleInjected = true;
}

function getReactDOM(): any {
  if (ReactDOM && (typeof ReactDOM.createRoot === 'function' || typeof ReactDOM.render === 'function')) {
    return ReactDOM;
  }
  const wp = (window as any).Vencord?.Webpack;
  if (wp?.Common?.ReactDOM) return wp.Common.ReactDOM;
  const found = findByProps('createRoot', 'render') || findByProps('render', 'unmountComponentAtNode');
  if (found) return found;
  if ((window as any).ReactDOM) return (window as any).ReactDOM;
  return ReactDOM;
}

function renderSidebar() {
  try {
    const dom = getReactDOM();

    if (!rootContainer) {
      rootContainer = document.createElement('div');
      rootContainer.id = 'vencord-ai-sidebar-root';
      const targetParent = document.getElementById('app-mount') || document.body;
      targetParent.appendChild(rootContainer);

      if (dom?.createRoot) {
        reactRoot = dom.createRoot(rootContainer);
      }
    }

    if (!isSidebarOpen) {
      rootContainer.style.display = 'none';
      return;
    }

    rootContainer.style.display = 'flex';
    const element = (
      <SidebarPanel
        settings={currentSettings}
        onClose={() => {
          isSidebarOpen = false;
          renderSidebar();
        }}
      />
    );

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

// Attach to window for easy debugging from console
if (typeof window !== 'undefined') {
  (window as any).toggleVencordAIAssistant = toggleAIAssistant;
}

/**
 * Safe top bar header button injection
 */
function injectHeaderButton() {
  try {
    injectTooltipStyles();

    const existingBtn = document.getElementById('vencord-ai-header-btn');
    if (existingBtn) return;

    const toolbars = document.querySelectorAll(
      'section[class*="title_"] [class*="toolbar_"], [class*="upperContainer_"] [class*="toolbar_"], [class*="toolbar__"]'
    );
    if (!toolbars || toolbars.length === 0) return;

    const toolbar = toolbars[0];
    if (toolbar.querySelector('#vencord-ai-header-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'vencord-ai-header-btn';
    btn.setAttribute('data-tooltip', 'AI Message Assistant (Cmd+Shift+A)');
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
  }
}

export function startPlugin() {
  try {
    currentSettings = loadSavedSettings();
    window.addEventListener('keydown', handleKeyDown);

    headerInjectionTimeout = setTimeout(injectHeaderButton, 1000);
    headerPollInterval = setInterval(injectHeaderButton, 2000);

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
  authors: [{ name: 'Raymond', id: 0n }],
  settings: pluginSettings,
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
