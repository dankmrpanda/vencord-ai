/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { ChatSession } from '../types';
import { CloseIcon, TrashIcon } from './icons';

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
    <div className="vai-drawer" role="dialog" aria-label="Chat history">
      <div className="vai-drawer-head">
        <span className="vai-drawer-title">
          Chats in this conversation{disabled ? ' · stop the reply to switch' : ''}
        </span>
        <button className="vai-icon-btn vai-small" onClick={onClose} title="Close history" aria-label="Close history">
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="vai-drawer-body">
        {sessionsList.length === 0 ? (
          <div className="vai-drawer-empty">No saved chats here yet.</div>
        ) : (
          sessionsList.map((s) => {
            const isArmed = armed?.id === s.id;
            return (
              <div
                key={s.id}
                className="vai-history-item"
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-current={s.id === activeSessionId}
                aria-disabled={disabled}
                onClick={() => { if (!disabled) onSelectSession(s); }}
                onKeyDown={(e) => {
                  if (disabled || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                  e.preventDefault();
                  onSelectSession(s);
                }}
                title={s.title}
              >
                <div className="vai-history-text">
                  <div className="vai-history-title">{s.title || 'Untitled chat'}</div>
                  <div className="vai-history-meta">
                    {formatRelativeTime(s.updatedAt)} · {s.messages.length} message{s.messages.length === 1 ? '' : 's'}
                  </div>
                </div>
                <button
                  className={`vai-icon-btn vai-small vai-history-delete${isArmed ? ' vai-armed' : ''}`}
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
                  title={disabled ? 'Stop the reply to delete' : isArmed ? 'Click again to delete' : 'Delete chat'}
                  aria-label={isArmed ? `Confirm delete ${s.title || 'chat'}` : `Delete ${s.title || 'chat'}`}
                >
                  {isArmed ? 'Delete?' : <TrashIcon size={14} />}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
