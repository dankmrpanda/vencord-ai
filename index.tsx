/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from '@api/ContextMenu';
import definePlugin from '@utils/types';
import { createRoot as vcCreateRoot, Menu, React } from '@webpack/common';
import { clearAssistantLaunchRequest, getAssistantLaunchRequest, setAssistantLaunchRequest } from './assistantLaunch';
import { shortcutLabel } from './components/a11y';
import { getPluginErrorBoundary } from './components/PluginErrorBoundary';
import { SidebarPanel } from './components/SidebarPanel';
import { isEscapeForPanel, isUnhandledEscape } from './components/sidebarActions';
import { SIDEBAR_CSS } from './components/sidebarCss';
import { setSidebarDocked } from './components/sidebarLayout';
import { DiagnosticLogEntry, renderDiagnosticLogEntry, serializeLogArgument } from './diagnostics';
import { getCurrentScopeContext, isChannelAllowedInScope } from './discord/scope';
import { findByCode, findByProps } from './discord/stores';
import { getChatService } from './services/chatService';
import { startAssistantRuntime, stopAssistantRuntime } from './services/runtimeLifecycle';
import {
  DEFAULT_SETTINGS,
  loadSavedSettings,
  persistSettings,
  settings,
  SettingsPanel,
} from './settings';
import { AssistantLaunchRequest, ChannelType, DiscordChannel, DiscordMessage, PluginSettings } from './types';

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
    @keyframes vencord-ai-tooltip-appear {
      from { opacity: 0; transform: translate(-50%, -4px); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }

    #vencord-ai-header-btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      margin: 0 8px;
      border-radius: 4px;
      cursor: pointer;
      user-select: none;
      color: var(--interactive-normal, #b5bac1);
      transition: color 0.15s ease;
      flex-shrink: 0;
    }
    #vencord-ai-header-btn:focus-visible {
      outline: 2px solid var(--focus-primary, var(--brand-experiment, #5865f2)) !important;
      outline-offset: 1px;
    }
    #vencord-ai-header-btn:hover { color: var(--interactive-hover, #dbdee1); }
    #vencord-ai-header-btn[aria-pressed="true"] { color: var(--interactive-active, #ffffff); }

    /* Discord-style tooltip under the header button */
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
    ${SIDEBAR_CSS}
  `;
  document.head.appendChild(style);
  stylesheetInjected = true;
}

const pluginLogs: DiagnosticLogEntry[] = [];

export function logPlugin(level: 'info' | 'warn' | 'error', message: string, ...args: any[]) {
  const time = new Date().toLocaleTimeString();
  const fullMsg = `${message} ${args.map(serializeLogArgument).join(' ')}`.trim();
  pluginLogs.push({ time, level, message: fullMsg });
  if (pluginLogs.length > 60) pluginLogs.shift();
  if (level === 'error') console.error(`[VencordAI] ${message}`, ...args);
  else if (level === 'warn') console.warn(`[VencordAI] ${message}`, ...args);
  else console.log(`[VencordAI] ${message}`, ...args);
}



/**
 * Finds React 18's createRoot function using Vencord's resolution pattern.
 */
function findCreateRoot(): ((container: Element | DocumentFragment) => { render(children: any): void; unmount(): void }) | null {
  if (typeof vcCreateRoot === 'function') return vcCreateRoot;

  try {
    const candidates = [
      (window as any)?.Vencord?.Webpack?.Common?.createRoot,
      (window as any)?.ReactDOM?.createRoot,
      findByCode('(299));', '.onRecoverableError')?.createRoot,
      findByCode('(299));', '.onRecoverableError'),
      findByProps('createRoot', 'hydrateRoot')?.createRoot,
      findByProps('createRoot')?.createRoot,
      findByProps('createRoot'),
    ];

    for (const fn of candidates) {
      if (typeof fn === 'function') return fn;
    }
  } catch {}

  return null;
}

/**
 * Gets a legacy ReactDOM module (with render/unmountComponentAtNode/createPortal).
 */
function getLegacyReactDOM(): any {
  if (typeof window !== 'undefined') {
    if ((window as any).ReactDOM) return (window as any).ReactDOM;
    const vcRDOM = (window as any).Vencord?.Webpack?.Common?.ReactDOM;
    if (vcRDOM) {
      const actual = vcRDOM.default || vcRDOM;
      if (typeof actual.render === 'function') return actual;
    }
  }
  const mod = findByProps('render', 'unmountComponentAtNode') || findByProps('createPortal');
  return mod?.default || mod || null;
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

    setSidebarDocked(isSidebarOpen);
    document.getElementById('vencord-ai-header-btn')?.setAttribute('aria-pressed', String(isSidebarOpen));
    if (!isSidebarOpen) {
      rootContainer.style.display = 'none';
      return;
    }

    rootContainer.style.display = 'flex';

    const panel = (
      <SidebarPanel
        settings={currentSettings}
        onClose={closeSidebar}
        onOpenSettings={getPluginSettingsOpener()}
        logs={pluginLogs}
        launchRequest={getAssistantLaunchRequest()}
        onLaunchConsumed={() => {
          clearAssistantLaunchRequest();
          renderSidebar();
        }}
      />
    );
    const ErrorBoundary = getPluginErrorBoundary();
    const element = <ErrorBoundary logs={pluginLogs}>{panel}</ErrorBoundary>;

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
    const logsHtml = pluginLogs.map(renderDiagnosticLogEntry).join('');

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

// UI-Q02: Vencord exposes openPluginModal on its global; without it the settings buttons stay hidden.
function getPluginSettingsOpener(): (() => void) | undefined {
  const vencord = typeof window !== 'undefined' ? (window as any).Vencord : undefined;
  const open = vencord?.Components?.openPluginModal;
  const plugin = vencord?.Plugins?.plugins?.AIAssistant;
  return typeof open === 'function' && plugin ? () => open(plugin) : undefined;
}

// UI-13: an unsent launch request ends with the panel, so it cannot attach to a later, unrelated question.
function closeSidebar() {
  isSidebarOpen = false;
  clearAssistantLaunchRequest();
  renderSidebar();
}

export function toggleAIAssistant() {
  if (isSidebarOpen) {
    closeSidebar();
    return;
  }
  isSidebarOpen = true;
  renderSidebar();
  // UI-Q05: opening the panel puts the cursor in its input.
  setTimeout(() => rootContainer?.querySelector('textarea')?.focus(), 0);
}

function launchAssistant(request: AssistantLaunchRequest): void {
  const scope = getCurrentScopeContext();
  if (!scope || !setAssistantLaunchRequest(request, scope)) return;
  isSidebarOpen = true;
  renderSidebar();
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props: { message?: DiscordMessage }) => {
  const message = props.message;
  const scope = getCurrentScopeContext();
  if (!message || !scope || !isChannelAllowedInScope(message.channel_id, scope)) return;
  children.push(
    <Menu.MenuItem
      id="vencord-ai-ask-message"
      label="Ask AI about this message"
      action={() => launchAssistant({
        targetChannelId: message.channel_id,
        targetMessageId: message.id,
        mode: 'message',
        initialPrompt: 'Explain this message and its surrounding context.',
      })}
    />,
  );
};

const threadContextMenuPatch: NavContextMenuPatchCallback = (children, props: { channel?: DiscordChannel }) => {
  const channel = props.channel;
  const scope = getCurrentScopeContext();
  const isForum = channel?.type === ChannelType.GUILD_FORUM;
  const supported = channel?.isThread?.()
    || channel?.type === ChannelType.PUBLIC_THREAD
    || channel?.type === ChannelType.PRIVATE_THREAD
    || channel?.type === ChannelType.ANNOUNCEMENT_THREAD
    || channel?.type === ChannelType.GUILD_FORUM;
  if (!channel || !supported || !scope || !isChannelAllowedInScope(channel.id, scope)) return;
  children.push(
    <Menu.MenuItem
      id="vencord-ai-summarize-thread"
      label={isForum ? 'Summarize this forum' : 'Summarize this thread'}
      action={() => launchAssistant({
        targetChannelId: channel.id,
        mode: 'thread',
        initialPrompt: isForum
          ? 'Summarize the relevant posts in this forum, including decisions, open questions, and cited key messages.'
          : 'Summarize this thread, including decisions, open questions, and cited key messages.',
      })}
    />,
  );
};

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
    const platform = (navigator as any).userAgentData?.platform || navigator.platform;
    btn.setAttribute('data-tooltip', `AI Assistant (${shortcutLabel(platform)})`);
    btn.setAttribute('aria-label', 'AI Message Assistant');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-pressed', String(isSidebarOpen));
    // Discord's toolbar icons are 24px SVGs drawn in currentColor; the sparkle matches the panel's mark.
    btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5c.4 3.9 1.7 6.6 3.4 8.1 1.6 1.4 3.8 2.1 6.1 2.4-2.3.3-4.5 1-6.1 2.4-1.7 1.5-3 4.2-3.4 8.1-.4-3.9-1.7-6.6-3.4-8.1C7 14 4.8 13.3 2.5 13c2.3-.3 4.5-1 6.1-2.4C10.3 9.1 11.6 6.4 12 2.5Z"/><path d="M19 2l.6 1.9L21.5 4.5l-1.9.6L19 7l-.6-1.9-1.9-.6 1.9-.6Z"/></svg>';

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
  } else if (isSidebarOpen && isUnhandledEscape(e) && isEscapeForPanel(e.target, rootContainer, document.body)) {
    // UI-04: the panel's own layers (mention popup, drawers) handle Escape first and mark it handled.
    e.preventDefault();
    toggleAIAssistant();
  }
}

export function startPlugin() {
  try {
    currentSettings = loadSavedSettings();
    getChatService(currentSettings);
    startAssistantRuntime(window);
    window.addEventListener('keydown', handleKeyDown);
    // UI-14: exists only while the plugin runs, so a stopped plugin cannot be remounted from outside.
    (window as any).toggleVencordAIAssistant = toggleAIAssistant;

    headerInjectionTimeout = setTimeout(injectHeaderButton, 500);
    headerPollInterval = setInterval(injectHeaderButton, 1000);

    console.log('[VencordAI] AI Assistant Plugin started successfully.');
  } catch (err) {
    console.error('[VencordAI] Error starting plugin:', err);
  }
}

export function stopPlugin() {
  // Start cleanup before DOM teardown so a rendering error cannot skip model unloading.
  void stopAssistantRuntime();
  try {
    window.removeEventListener('keydown', handleKeyDown);
    if ((window as any).toggleVencordAIAssistant === toggleAIAssistant) delete (window as any).toggleVencordAIAssistant;
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

    setSidebarDocked(false);
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
    clearAssistantLaunchRequest();

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
        getChatService(newSettings).updateSettings(newSettings);
        renderSidebar();
      }}
    />
  ),
  contextMenus: {
    message: messageContextMenuPatch,
    'channel-context': threadContextMenuPatch,
    'thread-context': threadContextMenuPatch,
  },
  start: startPlugin,
  stop: stopPlugin,
});
