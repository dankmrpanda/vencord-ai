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
  /** True while a reply is generating: sessions cannot be switched or deleted until it ends. */
  disabled?: boolean;
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

export const DELETE_CONFIRM_MS = 3000;

/** UI-Q08: the first click on a chat's delete button arms it; a second click on the same chat within the window deletes. */
export function deleteClickAction(
  armed: { id: string; at: number } | null,
  id: string,
  now: number,
  windowMs = DELETE_CONFIRM_MS,
): 'delete' | 'arm' {
  return armed?.id === id && now - armed.at <= windowMs ? 'delete' : 'arm';
}

export const HistoryDrawer: React.FC<HistoryDrawerProps> = ({
  isOpen,
  sessionsList,
  activeSessionId,
  disabled = false,
  onSelectSession,
  onDeleteSession,
  onClose,
}) => {
  const [armed, setArmed] = React.useState<{ id: string; at: number } | null>(null);
  React.useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), DELETE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!isOpen) return null;

  return (
    <div style={historyDrawerStyle}>
      <div style={historyHeaderStyle}>
        <span>Chat Sessions ({sessionsList.length}){disabled ? ' · stop generating to switch' : ''}</span>
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
              style={{
                ...(s.id === activeSessionId ? activeHistoryItemStyle : historyItemStyle),
                ...(disabled ? { cursor: 'not-allowed', opacity: 0.6 } : {}),
              }}
              onClick={() => { if (!disabled) onSelectSession(s); }}
              title={s.title}
            >
              <div style={historyTitleStyle}>{s.title || 'Untitled Chat'}</div>
              <div style={historyMetaStyle}>
                {formatRelativeTime(s.updatedAt)} · {s.messages.length} msgs
              </div>
              <button
                style={deleteButtonStyle}
                onClick={(e) => {
                  e.stopPropagation();
                  if (disabled) return;
                  if (deleteClickAction(armed, s.id, Date.now()) === 'arm') {
                    setArmed({ id: s.id, at: Date.now() });
                    return;
                  }
                  setArmed(null);
                  onDeleteSession(e, s.id);
                }}
                disabled={disabled}
                title={disabled ? 'Stop generating to delete' : armed?.id === s.id ? 'Click again to delete' : 'Delete Chat'}
                aria-label={armed?.id === s.id ? `Confirm delete ${s.title || 'chat'}` : `Delete ${s.title || 'chat'}`}
              >
                {armed?.id === s.id ? 'Delete?' : '🗑️'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
