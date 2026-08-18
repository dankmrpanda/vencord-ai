/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { getCurrentScopeContext } from '../discord/scope';
import { getCurrentChannelId, getSelectedChannelStore, searchMentionableUsers } from '../discord/stores';
import { AIAssistantAgent } from '../llm/agent';
import {
  createNewSession,
  deleteSession,
  getSessionsForChannel,
  saveSession,
} from '../storage/chatHistory';
import {
  AgentStep,
  AssistantChatMessage,
  ChatSession,
  CitationItem,
  CurrentScopeContext,
  DiscordUser,
  PluginSettings,
} from '../types';
import { ChatMessage } from './ChatMessage';
import { ScopeIndicator } from './ScopeIndicator';

interface SidebarPanelProps {
  settings: PluginSettings;
  onClose: () => void;
  onOpenSettings?: () => void;
  logs?: Array<{ time: string; level: string; message: string }>;
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

export const SidebarPanel: React.FC<SidebarPanelProps> = ({
  settings,
  onClose,
  onOpenSettings,
  logs = [],
}) => {
  const [currentScope, setCurrentScope] = React.useState<CurrentScopeContext | null>(() => {
    try {
      return getCurrentScopeContext();
    } catch {
      return null;
    }
  });
  const [session, setSession] = React.useState<ChatSession | null>(() => {
    try {
      const chId = getCurrentChannelId() || 'global';
      return createNewSession(chId, 'New Chat');
    } catch {
      return createNewSession('global', 'New Chat');
    }
  });
  const [sessionsList, setSessionsList] = React.useState<ChatSession[]>([]);
  const [showHistory, setShowHistory] = React.useState(false);
  const [showDebug, setShowDebug] = React.useState(false);
  const [inputText, setInputText] = React.useState('');
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [mentionSuggestions, setMentionSuggestions] = React.useState<DiscordUser[]>([]);
  const [mentionSelectedIndex, setMentionSelectedIndex] = React.useState(0);

  const abortControllerRef = React.useRef<AbortController | null>(null);
  const messagesEndRef = React.useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const isUserScrolledUpRef = React.useRef(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const agentRef = React.useRef<AIAssistantAgent>(null!);
  if (!agentRef.current) {
    agentRef.current = new AIAssistantAgent(settings);
  }
  const lastChannelIdRef = React.useRef<string | null>(null);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // If the user is scrolled more than 80px above the bottom, consider them "scrolled up"
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isUserScrolledUpRef.current = distanceFromBottom > 80;
  };

  React.useEffect(() => {
    agentRef.current?.updateSettings(settings);
  }, [settings]);

  const loadChannelScopeAndSessions = (channelId: string | null) => {
    try {
      const scope = getCurrentScopeContext();
      setCurrentScope(scope);

      const targetId = channelId || 'global';
      getSessionsForChannel(targetId)
        .then((list) => {
          setSessionsList(list);
          if (list.length > 0) {
            setSession(list[0]);
          } else {
            const newSess = createNewSession(targetId, 'New Chat');
            setSession(newSess);
          }
        })
        .catch((err) => {
          console.error('[VencordAI] Error loading chat history:', err);
          const newSess = createNewSession(targetId, 'New Chat');
          setSession(newSess);
        });
    } catch (err) {
      console.error('[VencordAI] Error in loadChannelScopeAndSessions:', err);
    }
  };

  React.useEffect(() => {
    try {
      const initialChId = getCurrentChannelId();
      lastChannelIdRef.current = initialChId;
      loadChannelScopeAndSessions(initialChId);

      const checkChannelChange = () => {
        try {
          const currentChId = getCurrentChannelId();
          if (currentChId && currentChId !== lastChannelIdRef.current) {
            lastChannelIdRef.current = currentChId;
            loadChannelScopeAndSessions(currentChId);
          }
        } catch (err) {
          console.error('[VencordAI] Error on channel change check:', err);
        }
      };

      const selStore = getSelectedChannelStore();
      if (selStore?.addChangeListener) {
        try {
          selStore.addChangeListener(checkChannelChange);
        } catch {}
      }

      const interval = setInterval(checkChannelChange, 1000);

      return () => {
        if (selStore?.removeChangeListener) {
          try {
            selStore.removeChangeListener(checkChannelChange);
          } catch {}
        }
        clearInterval(interval);
      };
    } catch (err) {
      console.error('[VencordAI] Error setting up channel change listener:', err);
    }
  }, []);

  React.useEffect(() => {
    // Only auto-scroll if the user hasn't explicitly scrolled up to read earlier messages
    if (!isUserScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: isGenerating ? 'auto' : 'smooth' });
    }
  }, [session?.messages, isGenerating]);

  const handleNewChat = () => {
    const channelId = session?.channelId || getCurrentChannelId() || 'global';
    const newSess = createNewSession(channelId, 'New Conversation');
    isUserScrolledUpRef.current = false;
    setSession(newSess);
    setSessionsList((prev) => [newSess, ...prev.filter((s) => s.id !== newSess.id)]);
    setShowHistory(false);
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      textareaRef.current?.focus();
    }, 50);
  };

  const handleSelectSession = (selected: ChatSession) => {
    isUserScrolledUpRef.current = false;
    setSession(selected);
    setShowHistory(false);
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      textareaRef.current?.focus();
    }, 50);
  };

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteSession(id);
    if (!session) return;
    const updated = sessionsList.filter((s) => s.id !== id);
    setSessionsList(updated);
    if (session.id === id) {
      if (updated.length > 0) {
        setSession(updated[0]);
      } else {
        handleNewChat();
      }
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsGenerating(false);
  };

  const handleSend = async (customPrompt?: string) => {
    const promptToSend = customPrompt || inputText.trim();
    if (!promptToSend || isGenerating || !session) return;

    isUserScrolledUpRef.current = false;
    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setIsGenerating(true);

    const userMessage: AssistantChatMessage = {
      id: `usr_${Date.now()}`,
      role: 'user',
      content: promptToSend,
      timestamp: Date.now(),
    };

    const assistantMsgId = `ast_${Date.now()}`;
    const assistantMessage: AssistantChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      steps: [],
      citations: [],
      timestamp: Date.now(),
      isStreaming: true,
    };

    const updatedMessages = [...session.messages, userMessage, assistantMessage];
    const updatedSession: ChatSession = {
      ...session,
      title: session.messages.length === 0 ? promptToSend.slice(0, 30) : session.title,
      messages: updatedMessages,
    };
    setSession(updatedSession);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await agentRef.current.run(
        promptToSend,
        session.messages,
        {
          onToken: (token) => {
            setSession((prev) => {
              if (!prev) return prev;
              const msgs = [...prev.messages];
              const last = msgs[msgs.length - 1];
              if (last && last.id === assistantMsgId) {
                last.content += token;
              }
              return { ...prev, messages: msgs };
            });
          },
          onStepAdded: (step: AgentStep) => {
            setSession((prev) => {
              if (!prev) return prev;
              const msgs = [...prev.messages];
              const last = msgs[msgs.length - 1];
              if (last && last.id === assistantMsgId) {
                last.steps = [...(last.steps || []), step];
              }
              return { ...prev, messages: msgs };
            });
          },
          onStepUpdated: (step: AgentStep) => {
            setSession((prev) => {
              if (!prev) return prev;
              const msgs = [...prev.messages];
              const last = msgs[msgs.length - 1];
              if (last && last.id === assistantMsgId) {
                last.steps = (last.steps || []).map((s) => (s.id === step.id ? step : s));
              }
              return { ...prev, messages: msgs };
            });
          },
          onCitationsUpdated: (citations: CitationItem[]) => {
            setSession((prev) => {
              if (!prev) return prev;
              const msgs = [...prev.messages];
              const last = msgs[msgs.length - 1];
              if (last && last.id === assistantMsgId) {
                last.citations = citations;
              }
              return { ...prev, messages: msgs };
            });
          },
        },
        controller.signal
      );

      setSession((prev) => {
        if (!prev) return prev;
        const msgs = [...prev.messages];
        const last = { ...msgs[msgs.length - 1] };
        if (last && last.id === assistantMsgId) {
          last.content = result.content;
          last.steps = result.steps;
          last.citations = result.citations;
          last.isStreaming = false;
          msgs[msgs.length - 1] = last;
        }
        const savedSession: ChatSession = { ...prev, messages: msgs, updatedAt: Date.now() };
        saveSession(savedSession);
        setSessionsList((prevList) => {
          const exists = prevList.some((s) => s.id === savedSession.id);
          if (exists) {
            return prevList.map((s) => (s.id === savedSession.id ? savedSession : s));
          }
          return [savedSession, ...prevList];
        });
        return savedSession;
      });
    } catch (err: any) {
      if (err.message !== 'Agent execution cancelled.') {
        setSession((prev) => {
          if (!prev) return prev;
          const msgs = [...prev.messages];
          const last = { ...msgs[msgs.length - 1] };
          if (last && last.id === assistantMsgId) {
            last.content = `⚠️ **Error**: ${err.message || String(err)}`;
            last.isStreaming = false;
            msgs[msgs.length - 1] = last;
          }
          const savedSession = { ...prev, messages: msgs, updatedAt: Date.now() };
          saveSession(savedSession);
          return savedSession;
        });
      }
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  const checkMentionTrigger = (text: string, cursorPosition: number) => {
    const textBeforeCursor = text.slice(0, cursorPosition);
    const match = textBeforeCursor.match(/(?:^|\s)@([a-zA-Z0-9_.]*)$/);
    if (match) {
      const query = match[1];
      const results = searchMentionableUsers(query, currentScope?.channelId, currentScope?.guildId);
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
            onClick={() => setShowHistory(!showHistory)}
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

      {/* Debug Diagnostics Drawer Overlay */}
      {showDebug && (
        <div style={historyDrawerStyle}>
          <div style={historyHeaderStyle}>
            <span>🐞 Debug Diagnostics ({logs.length} events)</span>
            <button style={textButtonStyle} onClick={() => setShowDebug(false)}>
              Close
            </button>
          </div>
          <div style={{ padding: '10px 14px', backgroundColor: 'var(--background-secondary-alt, #232428)', borderBottom: '1px solid var(--background-modifier-accent, #3f4147)', fontSize: '11px', color: 'var(--text-muted, #949ba4)' }}>
            <div><strong>Active Channel:</strong> {currentScope?.channelName || 'None'} ({currentScope?.channelId || 'None'})</div>
            <div><strong>Scope:</strong> {currentScope?.isGuild ? 'Guild/Server' : currentScope?.isDM ? 'Direct Message' : 'Global'}</div>
            <div><strong>Model:</strong> {settings.model} @ {settings.baseUrl}</div>
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
                    color: l.level === 'error' ? '#f23f43' : l.level === 'warn' ? '#f0b232' : 'var(--text-normal, #dbdee1)',
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
      )}

      {/* History Drawer Overlay */}
      {showHistory && (
        <div style={historyDrawerStyle}>
          <div style={historyHeaderStyle}>
            <span>Chat Sessions ({sessionsList.length})</span>
            <button style={textButtonStyle} onClick={() => setShowHistory(false)}>
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
                  style={s.id === session?.id ? activeHistoryItemStyle : historyItemStyle}
                  onClick={() => handleSelectSession(s)}
                  title={s.title}
                >
                  <div style={historyTitleStyle}>{s.title || 'Untitled Chat'}</div>
                  <div style={historyMetaStyle}>
                    {formatRelativeTime(s.updatedAt)} · {s.messages.length} msgs
                  </div>
                  <button
                    style={deleteButtonStyle}
                    onClick={(e) => handleDeleteSession(e, s.id)}
                    title="Delete Chat"
                  >
                    🗑️
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Message Stream */}
      <div
        style={messagesScrollContainerStyle}
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {(!session || !session.messages || session.messages.length === 0) ? (
          <div style={emptyStateContainerStyle}>
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>🤖</div>
            <div style={emptyTitleStyle}>Ask anything about your messages!</div>
            <div style={emptySubtitleStyle}>
              I can search 100k+ past messages, find image attachments, and fetch context across your
              channels.
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
          <button style={stopButtonStyle} onClick={handleStop}>
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

const panelContainerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  backgroundColor: 'var(--background-primary, #313338)',
  borderLeft: '1px solid var(--background-modifier-accent, #3f4147)',
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  userSelect: 'text',
};

const panelHeaderStyle: React.CSSProperties = {
  height: '48px',
  padding: '0 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
  flexShrink: 0,
};

const headerTitleGroupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

const headerTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '14px',
  color: 'var(--header-primary, #f2f3f5)',
};

const headerActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
};

const iconButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: '6px',
  borderRadius: '4px',
  color: 'var(--interactive-normal, #b5bac1)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '14px',
  transition: 'background-color 0.15s ease, color 0.15s ease',
};

const activeIconButtonStyle: React.CSSProperties = {
  ...iconButtonStyle,
  backgroundColor: 'var(--background-modifier-selected, rgba(255, 255, 255, 0.12))',
  color: 'var(--interactive-active, #ffffff)',
};

const textButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--text-muted, #949ba4)',
  fontSize: '12px',
  cursor: 'pointer',
};

const historyDrawerStyle: React.CSSProperties = {
  position: 'absolute',
  top: '48px',
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'var(--background-primary, #313338)',
  zIndex: 10,
  display: 'flex',
  flexDirection: 'column',
};

const historyHeaderStyle: React.CSSProperties = {
  padding: '12px 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontWeight: 600,
  fontSize: '13px',
  color: 'var(--header-secondary, #b5bac1)',
  borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
};

const emptyHistoryTextStyle: React.CSSProperties = {
  padding: '24px',
  textAlign: 'center',
  color: 'var(--text-muted, #949ba4)',
  fontSize: '12px',
};

const historyListStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px',
};

const historyItemStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: '6px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  marginBottom: '6px',
  cursor: 'pointer',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  border: '1px solid transparent',
  transition: 'border-color 0.15s ease',
};

const activeHistoryItemStyle: React.CSSProperties = {
  ...historyItemStyle,
  borderColor: 'var(--brand-experiment, #5865f2)',
  backgroundColor: 'var(--background-secondary-alt, #232428)',
};

const historyTitleStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--text-normal, #dbdee1)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '220px',
};

const historyMetaStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted, #949ba4)',
  marginTop: '2px',
};

const deleteButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--text-muted, #949ba4)',
  cursor: 'pointer',
  padding: '4px',
  fontSize: '12px',
};

const messagesScrollContainerStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '14px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const emptyStateContainerStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  padding: '20px',
  color: 'var(--text-muted, #949ba4)',
};

const emptyTitleStyle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: 'var(--header-primary, #f2f3f5)',
  marginBottom: '6px',
};

const emptySubtitleStyle: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '1.4',
  maxWidth: '260px',
  marginBottom: '20px',
};

const quickPromptsContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  width: '100%',
  maxWidth: '280px',
};

const quickPromptButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  borderRadius: '6px',
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '12px',
  cursor: 'pointer',
  textAlign: 'left',
};

const stopButtonContainerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  padding: '4px 0',
};

const stopButtonStyle: React.CSSProperties = {
  padding: '4px 14px',
  backgroundColor: 'var(--button-danger-background, #da373c)',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
};

const inputContainerStyle: React.CSSProperties = {
  position: 'relative',
  padding: '10px 12px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  borderTop: '1px solid var(--background-modifier-accent, #3f4147)',
  display: 'flex',
  gap: '8px',
  alignItems: 'flex-end',
  flexShrink: 0,
};

const mentionPopupContainerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: '12px',
  right: '12px',
  marginBottom: '6px',
  backgroundColor: 'var(--background-secondary-alt, #1e1f22)',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  borderRadius: '8px',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
  overflow: 'hidden',
  zIndex: 1000,
  maxHeight: '220px',
  display: 'flex',
  flexDirection: 'column',
};

const mentionPopupHeaderStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: '10px',
  fontWeight: 700,
  textTransform: 'uppercase',
  color: 'var(--text-muted, #949ba4)',
  backgroundColor: 'var(--background-tertiary, #111214)',
  borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
};

const mentionListStyle: React.CSSProperties = {
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  padding: '4px',
  gap: '2px',
};

const mentionItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '5px 8px',
  borderRadius: '4px',
  cursor: 'pointer',
  transition: 'background-color 0.1s ease',
};

const mentionItemActiveStyle: React.CSSProperties = {
  ...mentionItemStyle,
  backgroundColor: 'var(--background-modifier-selected, rgba(255, 255, 255, 0.12))',
};

const mentionAvatarPlaceholderStyle: React.CSSProperties = {
  width: '24px',
  height: '24px',
  borderRadius: '50%',
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '11px',
  fontWeight: 600,
  flexShrink: 0,
  overflow: 'hidden',
};

const mentionGlobalNameStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--header-primary, #f2f3f5)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const mentionUsernameStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted, #949ba4)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const botTagStyle: React.CSSProperties = {
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#fff',
  fontSize: '8px',
  fontWeight: 700,
  padding: '1px 3px',
  borderRadius: '3px',
  lineHeight: '1',
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  backgroundColor: 'var(--channeltextarea-background, #383a40)',
  border: 'none',
  borderRadius: '6px',
  padding: '8px 10px',
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '13px',
  lineHeight: '1.4',
  resize: 'none',
  fontFamily: 'inherit',
  outline: 'none',
  maxHeight: '120px',
};

const sendButtonStyle: React.CSSProperties = {
  width: '34px',
  height: '34px',
  borderRadius: '6px',
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '16px',
  cursor: 'pointer',
  flexShrink: 0,
};

const activeSendButtonStyle: React.CSSProperties = {
  ...sendButtonStyle,
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#fff',
};

const disabledSendButtonStyle: React.CSSProperties = {
  ...sendButtonStyle,
  backgroundColor: 'var(--background-modifier-accent, #3f4147)',
  color: 'var(--text-muted, #949ba4)',
  cursor: 'not-allowed',
};
