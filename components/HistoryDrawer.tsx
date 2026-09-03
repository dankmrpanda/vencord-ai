/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { ChatSession } from '../types';
import {
  activeHistoryItemStyle,
  deleteButtonStyle,
  emptyHistoryTextStyle,
  historyDrawerStyle,
  historyHeaderStyle,
  historyItemStyle,
  historyListStyle,
  historyMetaStyle,
  historyTitleStyle,
  textButtonStyle,
} from './sidebarStyles';

interface HistoryDrawerProps {
  isOpen: boolean;
  sessionsList: ChatSession[];
  activeSessionId?: string;
  onSelectSession: (session: ChatSession) => void;
  onDeleteSession: (e: React.MouseEvent, id: string) => void;
  onClose: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const HistoryDrawer: React.FC<HistoryDrawerProps> = ({
  isOpen,
  sessionsList,
  activeSessionId,
  onSelectSession,
  onDeleteSession,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div style={historyDrawerStyle}>
      <div style={historyHeaderStyle}>
        <span>Chat Sessions ({sessionsList.length})</span>
        <button style={textButtonStyle} onClick={onClose}>
          Close
        </button>
      </div>
      <div style={historyListStyle}>
        {sessionsList.length === 0 ? (
          <div style={emptyHistoryTextStyle}>No saved chats for this channel.</div>
        ) : (
          sessionsList.map((s) => (
            <div
              key={s.id}
              style={s.id === activeSessionId ? activeHistoryItemStyle : historyItemStyle}
              onClick={() => onSelectSession(s)}
              title={s.title}
            >
              <div style={historyTitleStyle}>{s.title || 'Untitled Chat'}</div>
              <div style={historyMetaStyle}>
                {formatRelativeTime(s.updatedAt)} · {s.messages.length} msgs
              </div>
              <button
                style={deleteButtonStyle}
                onClick={(e) => onDeleteSession(e, s.id)}
                title="Delete Chat"
              >
                🗑️
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
