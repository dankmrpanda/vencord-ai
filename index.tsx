import definePlugin from '@utils/types';
import { React, ReactDOM } from '@webpack/common';
import { SidebarPanel } from './components/SidebarPanel';
import { DEFAULT_SETTINGS, SettingsPanel } from './settings';
import { PluginSettings } from './types';

let rootContainer: HTMLDivElement | null = null;
let reactRoot: any = null;
let isSidebarOpen = false;
let currentSettings: PluginSettings = { ...DEFAULT_SETTINGS };
let headerPollInterval: any = null;

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
  try {
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
      if (ReactDOM?.createRoot) {
        reactRoot = ReactDOM.createRoot(rootContainer);
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
    } else if (ReactDOM?.render) {
      ReactDOM.render(element, rootContainer);
    }
  } catch (err) {
    console.error('[VencordAI] Error rendering sidebar:', err);
  }
}

export function toggleAIAssistant() {
  isSidebarOpen = !isSidebarOpen;
  renderSidebar();
}

/**
 * Safe top bar header button injection (runs on a calm timer, non-blocking)
 */
function injectHeaderButton() {
  try {
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
    btn.title = 'Open AI Message Assistant (Ctrl+Shift+A / Cmd+Shift+A)';
    btn.style.cursor = 'pointer';
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.margin = '0 6px';
    btn.style.fontSize = '18px';
    btn.style.lineHeight = '1';
    btn.style.opacity = '0.85';
    btn.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
    btn.innerText = '✨';

    btn.onmouseenter = () => {
      btn.style.opacity = '1';
      btn.style.transform = 'scale(1.1)';
    };
    btn.onmouseleave = () => {
      btn.style.opacity = '0.85';
      btn.style.transform = 'scale(1)';
    };
    btn.onclick = (e) => {
      e.stopPropagation();
      toggleAIAssistant();
    };

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

    // Initial safe injection attempt after Discord finish mounting
    setTimeout(injectHeaderButton, 1000);

    // Calm interval to re-inject if user navigates channels
    headerPollInterval = setInterval(injectHeaderButton, 2000);

    console.log('[VencordAI] AI Assistant Plugin started successfully.');
  } catch (err) {
    console.error('[VencordAI] Error starting plugin:', err);
  }
}

export function stopPlugin() {
  try {
    window.removeEventListener('keydown', handleKeyDown);
    if (headerPollInterval) {
      clearInterval(headerPollInterval);
      headerPollInterval = null;
    }

    const btn = document.getElementById('vencord-ai-header-btn');
    btn?.remove();

    if (reactRoot?.unmount) {
      reactRoot.unmount();
      reactRoot = null;
    } else if (ReactDOM?.unmountComponentAtNode && rootContainer) {
      ReactDOM.unmountComponentAtNode(rootContainer);
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
  settingsAboutComponent: () => (
    <SettingsPanel
      settings={currentSettings}
      onChange={(newSettings) => {
        persistSettings(newSettings);
        renderSidebar();
      }}
    />
  ),
  start: startPlugin,
  stop: stopPlugin,
});
