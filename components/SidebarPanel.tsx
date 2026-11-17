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
import { messageVersion, MemoChatMessage } from './ChatMessage';
import { DebugDrawer } from './DebugDrawer';
import { HistoryDrawer } from './HistoryDrawer';
import {
  ArrowDownIcon,
  BugIcon,
  CloseIcon,
  HistoryIcon,
  ImageIcon,
  LinkIcon,
  MessagesIcon,
  NewChatIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SparkleIcon,
  StopIcon,
} from './icons';
import { ScopeIndicator, scopeChipLabel } from './ScopeIndicator';
import {
  deleteHistorySession,
  escapeLayer,
  isEscapeForPanel,
  isNearBottom,
  inputAfterLaunchCleared,
  isImeComposing,
  isUnhandledEscape,
  keepScopeForChannel,
  LastSend,
  launchRequestForSend,
  retryLaunchRequest,
  retryPromptAt,
  selectHistorySession,
  shouldRefocusInput,
  streamScrollKey,
  syncSessionToChannel,
} from './sidebarActions';
import { getSidebarWidth, setSidebarWidth } from './sidebarLayout';

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
  const panelRef = React.useRef<HTMLDivElement | null>(null);
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
  const prevLaunchRef = React.useRef(launchRequest);
  React.useEffect(() => {
    const previous = prevLaunchRef.current;
    prevLaunchRef.current = launchRequest;
    // UI-13: the panel stays mounted while hidden; drop the canned prompt whose target was cleared on close.
    if (!launchRequest && previous) setInputText((text) => inputAfterLaunchCleared(text, previous));
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

  // UI-Q05: the textarea is disabled during a run; give focus back when it ends.
  const wasGeneratingRef = React.useRef(isGenerating);
  React.useEffect(() => {
    const focusInPanel = isEscapeForPanel(document.activeElement, panelRef.current, document.body);
    if (shouldRefocusInput(wasGeneratingRef.current, isGenerating, focusInPanel)) textareaRef.current?.focus();
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  // UI-Q09: Escape closes the mention popup, then an open drawer, before index.tsx closes the panel. Capture phase
  // runs before the window bubble listener in index.tsx, which skips events marked handled here.
  const popupOpen = mentionSuggestions.length > 0;
  const drawerOpen = showHistory || showDebug;
  React.useEffect(() => {
    if (!popupOpen && !drawerOpen) return;
    const onEscape = (e: KeyboardEvent) => {
      if (!isUnhandledEscape(e) || !isEscapeForPanel(e.target, panelRef.current, document.body)) return;
      if (!panelRef.current?.getClientRects().length) return; // hidden sidebar: leave Escape to Discord
      const layer = escapeLayer(popupOpen, drawerOpen);
      if (layer === 'panel') return;
      e.preventDefault();
      if (layer === 'popup') {
        setMentionSuggestions([]);
      } else {
        setShowHistory(false);
        setShowDebug(false);
      }
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [popupOpen, drawerOpen]);

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

  // A different session (channel follow, history pick, new chat) starts at the bottom, following.
  React.useEffect(() => {
    isUserScrolledUpRef.current = false;
    setShowJumpToLatest(false);
  }, [session?.id]);

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

  const lastSendRef = React.useRef<LastSend | null>(null);
  const handleSend = async (customPrompt?: string, retryRequest?: AssistantLaunchRequest | null) => {
    const promptToSend = customPrompt || inputText.trim();
    if (!promptToSend || isGenerating) return;

    isUserScrolledUpRef.current = false;
    if (!customPrompt) {
      // Quick prompts and Retry leave a half-typed question in the box alone.
      setInputText('');
    }

    // UI-13: quick prompts are unrelated questions; only the prefilled input box carries the launch target.
    const req = retryRequest || launchRequestForSend(launchRequest, customPrompt);
    if (req && !retryRequest) onLaunchConsumed?.();

    // SEC-09: the channel listener can lag; never send into another channel's session.
    await syncSessionToChannel(chatService, getCurrentChannelId).catch(() => false);
    // UI-01: keep the chosen scope, unless the channel changed before the listener noticed.
    const sendScope = scopeForChannel(currentScope, getCurrentChannelId());
    if (sendScope !== currentScope) setCurrentScope(sendScope);
    lastSendRef.current = { sessionId: chatService.getActiveSession()?.id, prompt: promptToSend, request: req };
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
    if (isImeComposing(e.nativeEvent)) return;
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
  };

  // The send handler reads current state, so rows memoised for streaming always retry through the latest one.
  const handleSendRef = React.useRef(handleSend);
  handleSendRef.current = handleSend;

  // The input grows with its text (also when a context-menu launch prefills it), up to the CSS max-height.
  React.useLayoutEffect?.(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [inputText]);

  // Drag the left edge to resize; the width is clamped so Discord keeps a usable chat column.
  const [resizing, setResizing] = React.useState(false);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = getSidebarWidth();
    const onMove = (ev: MouseEvent) => setSidebarWidth(startWidth + (startX - ev.clientX));
    const onUp = (ev: MouseEvent) => {
      setSidebarWidth(startWidth + (startX - ev.clientX), true);
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const resizeByKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setSidebarWidth(getSidebarWidth() + (e.key === 'ArrowLeft' ? 24 : -24), true);
  };
  React.useEffect(() => {
    const onWindowResize = () => setSidebarWidth(getSidebarWidth());
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  const where = currentScope?.isDM || currentScope?.isGroupDM ? 'in this DM' : 'here';
  const suggestions: Array<{ icon: React.ReactNode; label: string; prompt: string }> = [
    { icon: <MessagesIcon size={16} />, label: 'Summarize the recent conversation', prompt: `Summarize the recent conversation ${where}.` },
    { icon: <SearchIcon size={16} />, label: 'What were the main topics today?', prompt: `What were the main topics discussed ${where} today?` },
    { icon: <LinkIcon size={16} />, label: 'Find links and files shared', prompt: `Find the links and files shared ${where} recently.` },
    { icon: <ImageIcon size={16} />, label: 'Find the latest image', prompt: `Find the latest image shared ${where}.` },
  ];
  const scopeLabel = scopeChipLabel(currentScope);
  const hasMessages = Boolean(session?.messages?.length);
  const canSend = Boolean(inputText.trim()) && !isGenerating;
  const lastAssistantIndex = session ? session.messages.map((m) => m.role).lastIndexOf('assistant') : -1;

  return (
    <div className="vai-panel" ref={panelRef}>
      <div
        className={`vai-resize${resizing ? ' vai-active' : ''}`}
        onMouseDown={startResize}
        onKeyDown={resizeByKey}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize assistant panel"
        tabIndex={0}
        title="Drag to resize"
      />

      <div className="vai-header">
        <div className="vai-header-title">
          <SparkleIcon size={20} />
          <span>AI Assistant</span>
        </div>
        <div className="vai-header-actions">
          <button
            className="vai-icon-btn"
            onClick={handleNewChat}
            disabled={isGenerating}
            title={isGenerating ? 'New chat (stop the reply first)' : 'New chat'}
            aria-label="New chat"
          >
            <NewChatIcon />
          </button>
          <button
            className="vai-icon-btn"
            aria-pressed={showHistory}
            disabled={isGenerating && !showHistory}
            onClick={() => {
              if (isGenerating && !showHistory) return;
              refreshSessions(getCurrentChannelId());
              if (!showHistory) setShowDebug(false);
              setShowHistory(!showHistory);
            }}
            title={isGenerating && !showHistory ? 'Chat history (stop the reply first)' : 'Chat history'}
            aria-label="Chat history"
            aria-expanded={showHistory}
          >
            <HistoryIcon />
          </button>
          <button
            className="vai-icon-btn"
            aria-pressed={showDebug}
            onClick={() => {
              if (!showDebug) setShowHistory(false);
              setShowDebug(!showDebug);
            }}
            title="Diagnostics"
            aria-label="Debug diagnostics"
            aria-expanded={showDebug}
          >
            <BugIcon />
          </button>
          {onOpenSettings && (
            <button className="vai-icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
              <SettingsIcon />
            </button>
          )}
          <button className="vai-icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close assistant">
            <CloseIcon />
          </button>
        </div>
      </div>

      <DebugDrawer
        isOpen={showDebug}
        logs={logs}
        currentScope={currentScope}
        settings={settings}
        onClose={() => setShowDebug(false)}
      />
      <HistoryDrawer
        isOpen={showHistory}
        sessionsList={sessionsList}
        activeSessionId={session?.id}
        disabled={isGenerating}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onClose={() => setShowHistory(false)}
      />

      <div className="vai-scroll" ref={scrollContainerRef} onScroll={handleScroll}>
        {!hasMessages ? (
          <div className="vai-empty">
            <div className="vai-empty-mark"><SparkleIcon size={24} /></div>
            <h2>How can I help?</h2>
            <p>
              I can read and search {currentScope ? <strong>{scopeLabel}</strong> : 'the conversation you have open'} to
              answer questions. I only read: I never post, react or change anything.
            </p>
            <div className="vai-suggestions">
              {suggestions.map((s) => (
                <button key={s.label} className="vai-suggestion" onClick={() => handleSend(s.prompt)}>
                  {s.icon}
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          session!.messages.map((m, i) => {
            // UI-Q04: Retry re-sends the previous prompt as a new exchange (history keeps the old reply).
            const retryPrompt = isGenerating || i !== lastAssistantIndex ? null : retryPromptAt(session!.messages, i);
            return (
              <MemoChatMessage
                key={m.id}
                message={m}
                version={messageVersion(m)}
                onOpenSettings={onOpenSettings}
                onRetry={retryPrompt
                  ? () => handleSendRef.current(retryPrompt, retryLaunchRequest(lastSendRef.current, session!.id, retryPrompt))
                  : undefined}
              />
            );
          })
        )}
        <div className="vai-scroll-anchor" ref={messagesEndRef} />
      </div>

      <div className="vai-composer-wrap">
        {/* UI-Q01: shown while scrolled away from the latest content */}
        {showJumpToLatest && hasMessages && (
          <button className="vai-jump-latest" onClick={jumpToLatest} title="Scroll to the latest message">
            <ArrowDownIcon size={14} />
            Jump to latest
          </button>
        )}

        {mentionSuggestions.length > 0 && (
          <div className="vai-mentions">
            <div className="vai-mentions-title">Members</div>
            <div className="vai-mentions-list" role="listbox" aria-label="Mention suggestions">
              {mentionSuggestions.map((u, idx) => (
                <div
                  key={u.id}
                  className="vai-mention"
                  role="option"
                  aria-selected={idx === mentionSelectedIndex}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(u);
                  }}
                  onMouseEnter={() => setMentionSelectedIndex(idx)}
                >
                  {u.avatar ? (
                    <img
                      src={`https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=32`}
                      alt=""
                      onError={(e) => { (e.target as HTMLElement).style.visibility = 'hidden'; }}
                    />
                  ) : (
                    <span className="vai-face">{u.username.slice(0, 1).toUpperCase()}</span>
                  )}
                  <span className="vai-mention-name">{u.globalName || u.username}</span>
                  {u.bot && <span className="vai-bot-tag">BOT</span>}
                  <span className="vai-mention-user">{u.username}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="vai-composer">
          {launchRequest && (
            <div className="vai-attached">
              <span>
                Asking about <strong>{launchRequest.mode === 'thread' ? 'the selected thread' : 'the selected message'}</strong>
              </span>
              <button
                className="vai-icon-btn vai-small"
                onClick={() => onLaunchConsumed?.()}
                title="Remove the attached message"
                aria-label="Remove the attached message"
              >
                <CloseIcon size={14} />
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="vai-textarea"
            placeholder={currentScope ? `Ask about ${scopeLabel}` : 'Open a channel or DM to ask about it'}
            aria-label="Message the AI assistant"
            value={inputText}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <div className="vai-composer-foot">
            <ScopeIndicator context={currentScope} onScopeChange={setCurrentScope} />
            {isGenerating ? (
              <button
                className="vai-send vai-stop"
                style={{ marginLeft: 'auto' }}
                onClick={() => chatService.stopGenerating()}
                title="Stop generating"
                aria-label="Stop generating"
              >
                <StopIcon size={14} />
              </button>
            ) : (
              <button
                className="vai-send"
                style={{ marginLeft: 'auto' }}
                onClick={() => handleSend()}
                disabled={!canSend}
                title="Send (Enter) · New line (Shift+Enter)"
                aria-label="Send message"
              >
                <SendIcon size={16} />
              </button>
            )}
          </div>
        </div>
        <div className="vai-disclaimer">Read-only. Answers can be wrong; check the sources.</div>
      </div>
    </div>
  );
};
