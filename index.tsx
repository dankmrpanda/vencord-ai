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
    @keyframes vencord-ai-fade-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    #vencord-ai-floating-launcher {
      position: fixed;
      top: 10px;
      right: 220px;
      height: 28px;
      padding: 0 9px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      user-select: none;
      z-index: 99999;
      background-color: var(--background-secondary-alt, #232428);
      color: var(--header-primary, #f2f3f5);
      border: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.12));
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      transition: all 0.15s ease;
      font-family: var(--font-primary, "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif);
    }
    #vencord-ai-floating-launcher:hover {
      background-color: var(--brand-experiment, #5865f2);
      color: #ffffff;
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(88, 101, 242, 0.45);
    }
    #vencord-ai-floating-launcher:active {
      transform: translateY(0) scale(0.97);
    }
    #vencord-ai-floating-launcher[data-tooltip]:hover::before {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 7px);
      right: 50%;
      transform: translateX(50%);
      background-color: var(--background-floating, #111214);
      color: var(--text-normal, #dbdee1);
      padding: 6px 10px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      z-index: 100001;
      pointer-events: none;
      border: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.08));
      animation: vencord-ai-fade-in 0.12s ease;
    }
    #vencord-ai-floating-launcher[data-tooltip]:hover::after {
      content: '';
      position: absolute;
      top: calc(100% + 2px);
      right: 50%;
      transform: translateX(50%);
      border-width: 0 5px 5px 5px;
      border-style: solid;
      border-color: transparent transparent var(--background-floating, #111214) transparent;
      z-index: 100001;
      pointer-events: none;
      animation: vencord-ai-fade-in 0.12s ease;
    }

    #vencord-ai-sidebar-root {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 400px;
      max-width: 95vw;
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

function getReactDOM(): any {
  if (typeof window !== 'undefined') {
    const wp = (window as any).Vencord?.Webpack;
    if (wp?.Common?.ReactDOM) return wp.Common.ReactDOM;
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

if (typeof window !== 'undefined') {
  (window as any).toggleVencordAIAssistant = toggleAIAssistant;
}

function injectLauncherButton() {
  try {
    injectPluginStyles();

    const existingBtn = document.getElementById('vencord-ai-floating-launcher');
    if (existingBtn) return;

    const btn = document.createElement('div');
    btn.id = 'vencord-ai-floating-launcher';
    btn.setAttribute('data-tooltip', 'AI Message Assistant (Cmd+Shift+A)');
    btn.setAttribute('aria-label', 'AI Message Assistant');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = '<span>✨</span><span>AI Assistant</span>';

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

    document.body.appendChild(btn);
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

    injectLauncherButton();

    console.log('[VencordAI] AI Assistant Plugin started successfully.');
  } catch (err) {
    console.error('[VencordAI] Error starting plugin:', err);
  }
}

export function stopPlugin() {
  try {
    window.removeEventListener('keydown', handleKeyDown);

    const btn = document.getElementById('vencord-ai-floating-launcher');
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
