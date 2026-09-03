/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { CurrentScopeContext, PluginSettings } from '../types';
import {
  emptyHistoryTextStyle,
  historyDrawerStyle,
  historyHeaderStyle,
  historyListStyle,
  textButtonStyle,
} from './sidebarStyles';

interface DebugDrawerProps {
  isOpen: boolean;
  logs: Array<{ time: string; level: string; message: string }>;
  currentScope: CurrentScopeContext | null;
  settings: PluginSettings;
  onClose: () => void;
}

export const DebugDrawer: React.FC<DebugDrawerProps> = ({
  isOpen,
  logs,
  currentScope,
  settings,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div style={historyDrawerStyle}>
      <div style={historyHeaderStyle}>
        <span>🐞 Debug Diagnostics ({logs.length} events)</span>
        <button style={textButtonStyle} onClick={onClose}>
          Close
        </button>
      </div>
      <div
        style={{
          padding: '10px 14px',
          backgroundColor: 'var(--background-secondary-alt, #232428)',
          borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
          fontSize: '11px',
          color: 'var(--text-muted, #949ba4)',
        }}
      >
        <div>
          <strong>Active Channel:</strong> {currentScope?.channelName || 'None'} ({currentScope?.channelId || 'None'})
        </div>
        <div>
          <strong>Scope:</strong> {currentScope?.isGuild ? 'Guild/Server' : currentScope?.isDM ? 'Direct Message' : 'Global'}
        </div>
        <div>
          <strong>Model:</strong> {settings.model} @ {settings.baseUrl}
        </div>
      </div>
      <div style={historyListStyle}>
        {logs.length === 0 ? (
          <div style={emptyHistoryTextStyle}>No diagnostic logs captured yet.</div>
        ) : (
          logs.map((l, idx) => (
            <div
              key={idx}
              style={{
                padding: '6px 8px',
                borderRadius: '4px',
                backgroundColor: 'var(--background-secondary-alt, #232428)',
                marginBottom: '4px',
                fontSize: '11px',
                fontFamily: 'monospace',
                color:
                  l.level === 'error'
                    ? '#f23f43'
                    : l.level === 'warn'
                      ? '#f0b232'
                      : 'var(--text-normal, #dbdee1)',
                wordBreak: 'break-word',
              }}
            >
              <span style={{ color: 'var(--text-muted, #949ba4)', marginRight: '6px' }}>[{l.time}]</span>
              <span>{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
