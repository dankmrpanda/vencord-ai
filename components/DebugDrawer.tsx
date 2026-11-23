/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { CurrentScopeContext, PluginLogEntry, PluginSettings } from '../types';
import { CloseIcon } from './icons';

/** UI-11: shows only origin + path, so userinfo or a query-string token never appears on screen. */
export function displayBaseUrl(raw: string | undefined): string {
  if (!raw?.trim()) return '(not set)';
  try {
    const url = new URL(raw.trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}${url.pathname}`;
  } catch {}
  return '(invalid URL)';
}

interface DebugDrawerProps {
  isOpen: boolean;
  logs: PluginLogEntry[];
  currentScope: CurrentScopeContext | null;
  settings: PluginSettings;
  onClose: () => void;
}

export const DebugDrawer: React.FC<DebugDrawerProps> = ({ isOpen, logs, currentScope, settings, onClose }) => {
  if (!isOpen) return null;
  const where = currentScope?.isGuild ? 'Server channel' : currentScope?.isDM ? 'Direct message' : currentScope?.isGroupDM ? 'Group DM' : 'None';

  return (
    <div className="vai-drawer" role="dialog" aria-label="Diagnostics">
      <div className="vai-drawer-head">
        <span className="vai-drawer-title">Diagnostics · {logs.length} events</span>
        <button className="vai-icon-btn vai-small" onClick={onClose} title="Close diagnostics" aria-label="Close diagnostics">
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="vai-debug-facts">
        <div><strong>Conversation:</strong> {currentScope?.channelName || 'None'} ({where})</div>
        <div><strong>Model:</strong> {settings.model || '(not set)'} · {settings.providerPreset}</div>
        <div><strong>Server:</strong> {displayBaseUrl(settings.baseUrl)}</div>
      </div>
      <div className="vai-drawer-body">
        {logs.length === 0 ? (
          <div className="vai-drawer-empty">No diagnostic events yet.</div>
        ) : (
          logs.map((l, idx) => (
            <div key={idx} className={`vai-log${l.level === 'error' ? ' vai-error' : l.level === 'warn' ? ' vai-warn' : ''}`}>
              <time>{l.time}</time>{l.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
