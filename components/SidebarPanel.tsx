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
  activeIconButtonStyle,
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

  const messagesEndRef = React.useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const isUserScrolledUpRef = React.useRef(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const lastChannelIdRef = React.useRef<string | null>(null);

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

  const loadChannelScopeAndHistory = React.useCallback((channelId: string | null) => {
    try {
      const scope = getCurrentScopeContext();
      setCurrentScope(scope);
      const targetId = channelId || 'global';
      getSessionsForChannel(targetId)
        .then((list) => setSessionsList(list))
        .catch(() => setSessionsList([]));
    } catch {}
  }, []);

  // Listen to channel changes without blowing away active in-progress chat
  React.useEffect(() => {
    try {
      const initialChId = getCurrentChannelId();
      lastChannelIdRef.current = initialChId;
      loadChannelScopeAndHistory(initialChId);

      const checkChannelChange = () => {
        try {
          const currentChId = getCurrentChannelId();
          if (currentChId && currentChId !== lastChannelIdRef.current) {
            onLaunchConsumed?.();
            lastChannelIdRef.current = currentChId;
            loadChannelScopeAndHistory(currentChId);
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
  }, [onLaunchConsumed, loadChannelScopeAndHistory]);

  const session = chatService.getActiveSession();
  const isGenerating = chatService.isGenerating();

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isUserScrolledUpRef.current = distanceFromBottom > 80;
  };

  React.useEffect(() => {
    if (!isUserScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: isGenerating ? 'auto' : 'smooth' });
    }
  }, [session?.messages, isGenerating]);

  const handleNewChat = () => {
    const channelId = getCurrentChannelId() || 'global';
    chatService.newSession(channelId);
    isUserScrolledUpRef.current = false;
    setShowHistory(false);
    loadChannelScopeAndHistory(channelId);
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      textareaRef.current?.focus();
    }, 50);
  };

  const handleSelectSession = (selected: ChatSession) => {
    isUserScrolledUpRef.current = false;
    chatService.switchSession(selected);
    setShowHistory(false);
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      textareaRef.current?.focus();
    }, 50);
  };

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await chatService.deleteSession(id);
    const targetId = getCurrentChannelId() || 'global';
    loadChannelScopeAndHistory(targetId);
  };

  const handleSend = async (customPrompt?: string) => {
    const promptToSend = customPrompt || inputText.trim();
    if (!promptToSend || isGenerating) return;

    isUserScrolledUpRef.current = false;
    setInputText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const req = launchRequest;
    if (req) onLaunchConsumed?.();

    await chatService.sendMessage(promptToSend, req);
    const targetId = getCurrentChannelId() || 'global';
    loadChannelScopeAndHistory(targetId);
  };

  const checkMentionTrigger = (text: string, cursorPosition: number) => {
    const textBeforeCursor = text.slice(0, cursorPosition);
    const match = textBeforeCursor.match(/(?:^|\s)@([a-zA-Z0-9_.]*)$/);
    if (match) {
      const results = searchMentionableUsers(match[1], currentScope?.channelId, currentScope?.guildId);
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
    const match = textBeforeCursor.match(/(?:^|\s)@([a-zA-Z0-9_.]*)$/);
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
        insertMention(mentionSuggestions[mentionSelectedIndex]);
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
            style={showHistory ? activeIconButtonStyle : iconButtonStyle}
            onClick={() => {
              loadChannelScopeAndHistory(getCurrentChannelId());
              setShowHistory(!showHistory);
            }}
            title="Chat History"
          >
            🕒
          </button>
          <button style={iconButtonStyle} onClick={handleNewChat} title="New Chat">
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
      <ScopeIndicator context={currentScope} />

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
