import definePlugin from '@utils/types';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { SidebarPanel } from './components/SidebarPanel';
import { DEFAULT_SETTINGS, SettingsPanel } from './settings';
import { PluginSettings } from './types';

// Vencord Plugin interface helpers
let rootContainer: HTMLDivElement | null = null;
let reactRoot: any = null;
let isSidebarOpen = false;
let currentSettings: PluginSettings = { ...DEFAULT_SETTINGS };

const SETTINGS_KEY = 'VencordAI_Plugin_Settings';

function loadSavedSettings(): PluginSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('[VencordAI] Error loading settings:', err);
  }
  return { ...DEFAULT_SETTINGS };
}

function persistSettings(newSettings: PluginSettings) {
  currentSettings = newSettings;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
  } catch (err) {
    console.error('[VencordAI] Error persisting settings:', err);
  }
}

function renderSidebar() {
  if (!rootContainer) {
    rootContainer = document.createElement('div');
    rootContainer.id = 'vencord-ai-sidebar-root';
    rootContainer.style.position = 'fixed';
    rootContainer.style.right = '0';
    rootContainer.style.top = '0';
    rootContainer.style.bottom = '0';
    rootContainer.style.zIndex = '9999';
    rootContainer.style.display = 'flex';
    document.body.appendChild(rootContainer);
    reactRoot = ReactDOM.createRoot(rootContainer);
  }

  if (!isSidebarOpen) {
    rootContainer.style.display = 'none';
    return;
  }

  rootContainer.style.display = 'flex';
  reactRoot.render(
    <SidebarPanel
      settings={currentSettings}
      onClose={() => {
        isSidebarOpen = false;
        renderSidebar();
      }}
    />
  );
}

export function toggleAIAssistant() {
  isSidebarOpen = !isSidebarOpen;
  renderSidebar();
}

/**
 * Top bar header button injection
 */
function injectHeaderButton() {
  const existingBtn = document.getElementById('vencord-ai-header-btn');
  if (existingBtn) return;

  const toolbars = document.querySelectorAll('section[class*="title_"] [class*="toolbar_"], [class*="upperContainer_"] [class*="toolbar_"]');
  if (!toolbars || toolbars.length === 0) return;

  const toolbar = toolbars[0];
  const btn = document.createElement('div');
  btn.id = 'vencord-ai-header-btn';
  btn.title = 'Open AI Message Assistant (Ctrl+Shift+A / Cmd+Shift+A)';
  btn.style.cursor = 'pointer';
  btn.style.display = 'flex';
  btn.style.alignItems = 'center';
  btn.style.justifyContent = 'center';
  btn.style.margin = '0 6px';
  btn.style.fontSize = '18px';
  btn.style.lineHeight = '1';
  btn.style.opacity = '0.8';
  btn.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
  btn.innerText = '✨';

  btn.onmouseenter = () => {
    btn.style.opacity = '1';
    btn.style.transform = 'scale(1.1)';
  };
  btn.onmouseleave = () => {
    btn.style.opacity = '0.8';
    btn.style.transform = 'scale(1)';
  };
  btn.onclick = () => {
    toggleAIAssistant();
  };

  toolbar.prepend(btn);
}

// Global keyboard shortcut listener
function handleKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
    e.preventDefault();
    toggleAIAssistant();
  }
}

let observer: MutationObserver | null = null;

export function startPlugin() {
  currentSettings = loadSavedSettings();
  window.addEventListener('keydown', handleKeyDown);

  // Periodic check & mutation observer to keep topbar icon active across channel navigations
  injectHeaderButton();
  observer = new MutationObserver(() => {
    injectHeaderButton();
  });

  const appMount = document.getElementById('app-mount') || document.body;
  observer.observe(appMount, { childList: true, subtree: true });

  console.log('[VencordAI] AI Assistant Plugin started successfully.');
}

export function stopPlugin() {
  window.removeEventListener('keydown', handleKeyDown);
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  const btn = document.getElementById('vencord-ai-header-btn');
  btn?.remove();

  if (reactRoot) {
    reactRoot.unmount();
    reactRoot = null;
  }

  rootContainer?.remove();
  rootContainer = null;
  isSidebarOpen = false;

  console.log('[VencordAI] AI Assistant Plugin stopped.');
}

export default definePlugin({
  name: 'AIAssistant',
  description:
    'Client-side AI assistant to query 100k+ messages and images across channels & DMs with local (omlx, Ollama) and cloud LLMs.',
  authors: [{ name: 'Raymond' }],
  settings: {
    SettingsComponent: () => (
      <SettingsPanel
        settings={currentSettings}
        onChange={(newSettings) => {
          persistSettings(newSettings);
          renderSidebar();
        }}
      />
    ),
  },
  start: startPlugin,
  stop: stopPlugin,
});
