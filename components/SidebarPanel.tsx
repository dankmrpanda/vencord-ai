/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { getCurrentScopeContext } from '../discord/scope';
import { getCurrentChannelId, getSelectedChannelStore, searchMentionableUsers } from '../discord/stores';
import { getChatService } from '../services/chatService';
import { getSessionsForChannel } from '../storage/chatHistory';
import {
  AssistantLaunchRequest,
  ChatSession,
  CurrentScopeContext,
  DiscordUser,
  PluginSettings,
} from '../types';
import { ChatMessage } from './ChatMessage';
import { DebugDrawer } from './DebugDrawer';
import { HistoryDrawer } from './HistoryDrawer';
import { ScopeIndicator } from './ScopeIndicator';
import {
  deleteHistorySession,
  isNearBottom,
  keepScopeForChannel,
  selectHistorySession,
  streamScrollKey,
  syncSessionToChannel,
} from './sidebarActions';
import {
  activeIconButtonStyle,
  disabledIconButtonStyle,
  activeSendButtonStyle,
  botTagStyle,
  disabledSendButtonStyle,
  emptyStateContainerStyle,
  emptySubtitleStyle,
  emptyTitleStyle,
  headerActionsStyle,
  headerTitleGroupStyle,
  headerTitleStyle,
  iconButtonStyle,
  inputContainerStyle,
  jumpToLatestButtonStyle,
  mentionAvatarPlaceholderStyle,
  mentionGlobalNameStyle,
  mentionItemActiveStyle,
  mentionItemStyle,
  mentionListStyle,
  mentionPopupContainerStyle,
  mentionPopupHeaderStyle,
  mentionUsernameStyle,
  messagesScrollContainerStyle,
  panelContainerStyle,
  panelHeaderStyle,
  quickPromptButtonStyle,
  quickPromptsContainerStyle,
  stopButtonContainerStyle,
  stopButtonStyle,
  textareaStyle,
} from './sidebarStyles';

interface SidebarPanelProps {
  settings: PluginSettings;
  onClose: () => void;
  onOpenSettings?: () => void;
  logs?: Array<{ time: string; level: 'info' | 'warn' | 'error'; message: string }>;
  launchRequest?: AssistantLaunchRequest | null;
  onLaunchConsumed?: () => void;
}

export const SidebarPanel: React.FC<SidebarPanelProps> = ({
  settings,
  onClose,
  onOpenSettings,
  logs = [],
  launchRequest,
  onLaunchConsumed,
}) => {
  const chatService = getChatService(settings);
  const [, setRenderTick] = React.useState(0);
  const forceRender = React.useCallback(() => setRenderTick((t) => t + 1), []);

  const [currentScope, setCurrentScope] = React.useState<CurrentScopeContext | null>(() => {
    try { return getCurrentScopeContext(); } catch { return null; }
  });
  const [sessionsList, setSessionsList] = React.useState<ChatSession[]>([]);
  const [showHistory, setShowHistory] = React.useState(false);
  const [showDebug, setShowDebug] = React.useState(false);
  const [inputText, setInputText] = React.useState('');
  const [mentionSuggestions, setMentionSuggestions] = React.useState<DiscordUser[]>([]);
  const [mentionSelectedIndex, setMentionSelectedIndex] = React.useState(0);
  const [viewedChannelId, setViewedChannelId] = React.useState<string | null>(() => getCurrentChannelId());

  const messagesEndRef = React.useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const isUserScrolledUpRef = React.useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const lastChannelIdRef = React.useRef<string | null>(null);
  // index.tsx passes a new arrow on every render; a ref keeps the channel listener effect from re-running.
  const onLaunchConsumedRef = React.useRef(onLaunchConsumed);
  onLaunchConsumedRef.current = onLaunchConsumed;

  // Subscribe to background ChatService updates (tokens, steps, sessions, streaming)
  React.useEffect(() => {
    chatService.updateSettings(settings);
    return chatService.subscribe(forceRender);
  }, [chatService, settings, forceRender]);

  // Initial session initialization
  React.useEffect(() => {
    const chId = getCurrentChannelId() || undefined;
    chatService.initSession(chId).then(() => forceRender());
  }, [chatService, forceRender]);

  // Handle launch request (from context menu)
  React.useEffect(() => {
    if (!launchRequest) return;
    setInputText(launchRequest.initialPrompt);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [launchRequest]);

  // UI-01: refreshes the history list only; the scope is rebuilt only for another channel (see keepScopeForChannel).
  const refreshSessions = React.useCallback((channelId: string | null) => {
    getSessionsForChannel(channelId || 'global')
      .then((list) => setSessionsList(list))
      .catch(() => setSessionsList([]));
  }, []);

  const scopeForChannel = (scope: CurrentScopeContext | null, channelId: string | null): CurrentScopeContext | null => {
    const kept = keepScopeForChannel(scope, channelId);
    if (kept) return kept;
    try { return getCurrentScopeContext(); } catch { return null; }
  };

  // Listen to channel changes without blowing away active in-progress chat
  React.useEffect(() => {
    try {
      const initialChId = getCurrentChannelId();
      lastChannelIdRef.current = initialChId;
      refreshSessions(initialChId);

      const checkChannelChange = () => {
        try {
          const currentChId = getCurrentChannelId();
          if (currentChId && currentChId !== lastChannelIdRef.current) {
            onLaunchConsumedRef.current?.();
            lastChannelIdRef.current = currentChId;
            setViewedChannelId(currentChId);
            setCurrentScope((prev) => scopeForChannel(prev, currentChId));
            refreshSessions(currentChId);
          }
        } catch {}
      };

      const selStore = getSelectedChannelStore();
      if (selStore?.addChangeListener) {
        try { selStore.addChangeListener(checkChannelChange); } catch {}
      }

      const interval = setInterval(checkChannelChange, 1000);

      return () => {
        if (selStore?.removeChangeListener) {
          try { selStore.removeChangeListener(checkChannelChange); } catch {}
        }
        clearInterval(interval);
      };
    } catch {}
  }, [refreshSessions]);

  const session = chatService.getActiveSession();
  const isGenerating = chatService.isGenerating();

  // SEC-09: sessions are per channel. Whenever no run is in progress, show the viewed channel's session: after a
  // channel change, when the panel reopens in another channel, and when a run ends after the user moved.
  React.useEffect(() => {
    syncSessionToChannel(chatService, getCurrentChannelId).catch(() => {});
  }, [chatService, viewedChannelId, isGenerating, session?.id]);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const scrolledUp = !isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    isUserScrolledUpRef.current = scrolledUp;
    setShowJumpToLatest(scrolledUp);
  };

  const jumpToLatest = () => {
    isUserScrolledUpRef.current = false;
    setShowJumpToLatest(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // UI-03: follow the streaming reply (mutated in place) while the user is near the bottom.
  const scrollKey = streamScrollKey(session);
  React.useEffect(() => {
    if (!isUserScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: isGenerating ? 'auto' : 'smooth' });
    }
  }, [scrollKey, isGenerating]);

  const handleNewChat = () => {
    if (isGenerating) return;
    const channelId = getCurrentChannelId() || 'global';
    chatService.newSession(channelId);
    isUserScrolledUpRef.current = false;
    setShowHistory(false);
    refreshSessions(channelId);
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      textareaRef.current?.focus();
    }, 50);
  };

  const handleSelectSession = (selected: ChatSession) => {
    if (isGenerating) return;
    isUserScrolledUpRef.current = false;
    selectHistorySession(chatService, selected);
    setShowHistory(false);
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      textareaRef.current?.focus();
    }, 50);
  };

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!(await deleteHistorySession(chatService, id))) return;
    refreshSessions(getCurrentChannelId());
  };

  const handleSend = async (customPrompt?: string) => {
    const promptToSend = customPrompt || inputText.trim();
    if (!promptToSend || isGenerating) return;

    isUserScrolledUpRef.current = false;
    setInputText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const req = launchRequest;
    if (req) onLaunchConsumed?.();

    // SEC-09: the channel listener can lag; never send into another channel's session.
    await syncSessionToChannel(chatService, getCurrentChannelId).catch(() => false);
    // UI-01: keep the chosen scope, unless the channel changed before the listener noticed.
    const sendScope = scopeForChannel(currentScope, getCurrentChannelId());
    if (sendScope !== currentScope) setCurrentScope(sendScope);
    await chatService.sendMessage(promptToSend, req, sendScope || undefined);
    refreshSessions(getCurrentChannelId());
  };

  const checkMentionTrigger = (text: string, cursorPosition: number) => {
    const textBeforeCursor = text.slice(0, cursorPosition);
    const match = textBeforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (match) {
      const channelId = currentScope?.channelId || getCurrentChannelId() || undefined;
      const guildId = currentScope?.guildId || undefined;
      const results = searchMentionableUsers(match[1], currentScope || channelId, guildId);
      if (results.length > 0) {
        setMentionSuggestions(results);
        setMentionSelectedIndex(0);
        return;
      }
    }
    setMentionSuggestions([]);
  };

  const insertMention = (user: DiscordUser) => {
    const cursorPosition = textareaRef.current?.selectionStart ?? inputText.length;
    const textBeforeCursor = inputText.slice(0, cursorPosition);
    const textAfterCursor = inputText.slice(cursorPosition);
    const match = textBeforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (match) {
      const hasLeadingSpace = match[0].startsWith(' ');
      const prefix = textBeforeCursor.slice(0, match.index! + (hasLeadingSpace ? 1 : 0));
      const mentionTag = `@${user.username} `;
      const newText = prefix + mentionTag + textAfterCursor;
      setInputText(newText);
      setMentionSuggestions([]);
      setTimeout(() => {
        if (textareaRef.current) {
          const newPos = (prefix + mentionTag).length;
          textareaRef.current.selectionStart = newPos;
          textareaRef.current.selectionEnd = newPos;
          textareaRef.current.focus();
        }
      }, 10);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionSelectedIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionSelectedIndex((prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = mentionSuggestions[mentionSelectedIndex] || mentionSuggestions[0];
        if (selected) {
          insertMention(selected);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionSuggestions([]);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      setMentionSuggestions([]);
      handleSend();
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    checkMentionTrigger(val, e.target.selectionStart || val.length);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  return (
    <div style={panelContainerStyle}>
      {/* Panel Top Header */}
      <div style={panelHeaderStyle}>
        <div style={headerTitleGroupStyle}>
          <span style={{ fontSize: '16px' }}>✨</span>
          <span style={headerTitleStyle}>Discord AI Assistant</span>
        </div>
        <div style={headerActionsStyle}>
          <button
            style={showDebug ? activeIconButtonStyle : iconButtonStyle}
            onClick={() => setShowDebug(!showDebug)}
            title="Debug Diagnostics & Live Logs"
          >
            🐞
          </button>
          <button
            style={showHistory ? activeIconButtonStyle : isGenerating ? disabledIconButtonStyle : iconButtonStyle}
            onClick={() => {
              if (isGenerating && !showHistory) return;
              refreshSessions(getCurrentChannelId());
              setShowHistory(!showHistory);
            }}
            title={isGenerating && !showHistory ? 'Chat History (stop generating first)' : 'Chat History'}
          >
            🕒
          </button>
          <button
            style={isGenerating ? disabledIconButtonStyle : iconButtonStyle}
            onClick={handleNewChat}
            disabled={isGenerating}
            title={isGenerating ? 'New Chat (stop generating first)' : 'New Chat'}
          >
            ➕
          </button>
          {onOpenSettings && (
            <button style={iconButtonStyle} onClick={onOpenSettings} title="Settings">
              ⚙️
            </button>
          )}
          <button style={iconButtonStyle} onClick={onClose} title="Close Assistant (Esc)">
            ✕
          </button>
        </div>
      </div>

      {/* Scope Indicator */}
      <ScopeIndicator context={currentScope} onScopeChange={setCurrentScope} />

      {/* Debug Diagnostics Drawer */}
      <DebugDrawer
        isOpen={showDebug}
        logs={logs}
        currentScope={currentScope}
        settings={settings}
        onClose={() => setShowDebug(false)}
      />

      {/* History Drawer */}
      <HistoryDrawer
        isOpen={showHistory}
        sessionsList={sessionsList}
        activeSessionId={session?.id}
        disabled={isGenerating}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onClose={() => setShowHistory(false)}
      />

      {/* Message Stream */}
      <div style={messagesScrollContainerStyle} ref={scrollContainerRef} onScroll={handleScroll}>
        {!session || !session.messages || session.messages.length === 0 ? (
          <div style={emptyStateContainerStyle}>
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>🤖</div>
            <div style={emptyTitleStyle}>Ask anything about your messages!</div>
            <div style={emptySubtitleStyle}>
              I can search 100k+ past messages, find image attachments, and fetch context across your channels.
            </div>

            <div style={quickPromptsContainerStyle}>
              <button
                style={quickPromptButtonStyle}
                onClick={() => handleSend('What were the most important topics discussed recently?')}
              >
                💡 Summarize recent topics
              </button>
              <button
                style={quickPromptButtonStyle}
                onClick={() => handleSend('Find the last image or screenshot shared here')}
              >
                🖼️ Find last shared image
              </button>
              <button
                style={quickPromptButtonStyle}
                onClick={() => handleSend('Search for any links or files sent in this channel')}
              >
                🔗 Find shared links & files
              </button>
            </div>
          </div>
        ) : (
          session.messages.map((m) => <ChatMessage key={m.id} message={m} />)
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* UI-Q01: shown while scrolled away from the latest content */}
      {showJumpToLatest && Boolean(session?.messages.length) && (
        <div style={stopButtonContainerStyle}>
          <button style={jumpToLatestButtonStyle} onClick={jumpToLatest} title="Scroll to the latest message">
            ↓ Jump to latest
          </button>
        </div>
      )}

      {/* Stop Generating Button */}
      {isGenerating && (
        <div style={stopButtonContainerStyle}>
          <button style={stopButtonStyle} onClick={() => chatService.stopGenerating()}>
            ⏹ Stop Generating
          </button>
        </div>
      )}

      {/* Input Box */}
      <div style={inputContainerStyle}>
        {mentionSuggestions.length > 0 && (
          <div style={mentionPopupContainerStyle}>
            <div style={mentionPopupHeaderStyle}>Members matching mention</div>
            <div style={mentionListStyle}>
              {mentionSuggestions.map((u, idx) => (
                <div
                  key={u.id}
                  style={idx === mentionSelectedIndex ? mentionItemActiveStyle : mentionItemStyle}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(u);
                  }}
                  onClick={() => insertMention(u)}
                  onMouseEnter={() => setMentionSelectedIndex(idx)}
                >
                  <div style={mentionAvatarPlaceholderStyle}>
                    {u.avatar ? (
                      <img
                        src={`https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=32`}
                        alt={u.username}
                        style={{ width: '100%', height: '100%', borderRadius: '50%' }}
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      u.username.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={mentionGlobalNameStyle}>{u.globalName || u.username}</span>
                      {u.bot && <span style={botTagStyle}>BOT</span>}
                    </div>
                    <span style={mentionUsernameStyle}>@{u.username}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          style={textareaStyle}
          placeholder="Ask a question about messages, files, or @mention someone..."
          value={inputText}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={isGenerating}
        />
        <button
          style={inputText.trim() && !isGenerating ? activeSendButtonStyle : disabledSendButtonStyle}
          onClick={() => handleSend()}
          disabled={!inputText.trim() || isGenerating}
          title="Send message (Enter)"
        >
          ➔
        </button>
      </div>
    </div>
  );
};
