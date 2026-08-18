import { React, useEffect, useRef, useState } from '@webpack/common';
import { getCurrentScopeContext } from '../discord/scope';
import { getCurrentChannelId, getSelectedChannelStore } from '../discord/stores';
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
  PluginSettings,
} from '../types';
import { ChatMessage } from './ChatMessage';
import { ScopeIndicator } from './ScopeIndicator';

interface SidebarPanelProps {
  settings: PluginSettings;
  onClose: () => void;
  onOpenSettings?: () => void;
}

export const SidebarPanel: React.FC<SidebarPanelProps> = ({
  settings,
  onClose,
  onOpenSettings,
}) => {
  const [currentScope, setCurrentScope] = useState<CurrentScopeContext | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [sessionsList, setSessionsList] = useState<ChatSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const agentRef = useRef<AIAssistantAgent>(new AIAssistantAgent(settings));
  const lastChannelIdRef = useRef<string | null>(null);

  useEffect(() => {
    agentRef.current.updateSettings(settings);
  }, [settings]);

  const loadChannelScopeAndSessions = (channelId: string | null) => {
    const scope = getCurrentScopeContext();
    setCurrentScope(scope);

    if (channelId) {
      getSessionsForChannel(channelId).then((list) => {
        setSessionsList(list);
        if (list.length > 0) {
          setSession(list[0]);
        } else {
          const newSess = createNewSession(channelId, 'New Chat');
          setSession(newSess);
        }
      });
    }
  };

  // Track active channel changes dynamically
  useEffect(() => {
    const initialChId = getCurrentChannelId();
    lastChannelIdRef.current = initialChId;
    loadChannelScopeAndSessions(initialChId);

    const checkChannelChange = () => {
      const currentChId = getCurrentChannelId();
      if (currentChId && currentChId !== lastChannelIdRef.current) {
        lastChannelIdRef.current = currentChId;
        loadChannelScopeAndSessions(currentChId);
      }
    };

    const selStore = getSelectedChannelStore();
    if (selStore?.addChangeListener) {
      selStore.addChangeListener(checkChannelChange);
    }

    const interval = setInterval(checkChannelChange, 1000);

    return () => {
      if (selStore?.removeChangeListener) {
        selStore.removeChangeListener(checkChannelChange);
      }
      clearInterval(interval);
    };
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages]);

  const handleNewChat = () => {
    const channelId = session?.channelId || getCurrentChannelId() || 'global';
    const newSess = createNewSession(channelId, 'New Conversation');
    setSession(newSess);
    setSessionsList((prev) => [newSess, ...prev.filter((s) => s.id !== newSess.id)]);
    setShowHistory(false);
  };

  const handleSelectSession = (selected: ChatSession) => {
    setSession(selected);
    setShowHistory(false);
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

    setInputText('');
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

      // Finalize message
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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
            style={iconButtonStyle}
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
          <button style={iconButtonStyle} onClick={onClose} title="Close Assistant">
            ✕
          </button>
        </div>
      </div>

      {/* Scope Indicator */}
      <ScopeIndicator context={currentScope} />

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
            {sessionsList.map((s) => (
              <div
                key={s.id}
                style={s.id === session?.id ? activeHistoryItemStyle : historyItemStyle}
                onClick={() => handleSelectSession(s)}
              >
                <div style={historyTitleStyle}>{s.title}</div>
                <div style={historySubStyle}>
                  {new Date(s.updatedAt).toLocaleDateString()} · {s.messages.length} msgs
                </div>
                <button
                  style={deleteButtonStyle}
                  onClick={(e) => handleDeleteSession(e, s.id)}
                  title="Delete Chat"
                >
                  🗑️
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Message Stream */}
      <div style={messagesScrollContainerStyle}>
        {session?.messages.length === 0 ? (
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
          session?.messages.map((m) => <ChatMessage key={m.id} message={m} />)
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
        <textarea
          style={textareaStyle}
          placeholder="Ask a question about messages, files, or people..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={isGenerating}
        />
        <button
          style={inputText.trim() && !isGenerating ? activeSendButtonStyle : disabledSendButtonStyle}
          onClick={() => handleSend()}
          disabled={!inputText.trim() || isGenerating}
        >
          ➔
        </button>
      </div>
    </div>
  );
};

const panelContainerStyle: React.CSSProperties = {
  width: '380px',
  height: '100%',
  backgroundColor: 'var(--background-primary, #313338)',
  borderLeft: '1px solid var(--background-modifier-accent, #3f4147)',
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  zIndex: 100,
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
};

const historyDrawerStyle: React.CSSProperties = {
  position: 'absolute',
  top: '48px',
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  zIndex: 150,
  display: 'flex',
  flexDirection: 'column',
};

const historyHeaderStyle: React.CSSProperties = {
  padding: '12px 14px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
  fontWeight: 600,
  fontSize: '13px',
  color: 'var(--header-primary, #f2f3f5)',
};

const textButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--brand-experiment, #5865f2)',
  cursor: 'pointer',
  fontWeight: 600,
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
  backgroundColor: 'var(--background-secondary-alt, #232428)',
  marginBottom: '6px',
  cursor: 'pointer',
  position: 'relative',
};

const activeHistoryItemStyle: React.CSSProperties = {
  ...historyItemStyle,
  border: '1px solid var(--brand-experiment, #5865f2)',
};

const historyTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '12px',
  color: 'var(--header-primary, #f2f3f5)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  paddingRight: '24px',
};

const historySubStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--text-muted, #949ba4)',
  marginTop: '2px',
};

const deleteButtonStyle: React.CSSProperties = {
  position: 'absolute',
  right: '8px',
  top: '12px',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '12px',
  opacity: 0.7,
};

const messagesScrollContainerStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '12px',
  display: 'flex',
  flexDirection: 'column',
};

const emptyStateContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  textAlign: 'center',
  padding: '20px',
};

const emptyTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '15px',
  color: 'var(--header-primary, #f2f3f5)',
  marginBottom: '4px',
};

const emptySubtitleStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted, #949ba4)',
  lineHeight: '1.4',
  marginBottom: '20px',
};

const quickPromptsContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  width: '100%',
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
  padding: '4px 12px',
  backgroundColor: 'var(--button-danger-background, #da373c)',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
};

const inputContainerStyle: React.CSSProperties = {
  padding: '10px 12px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  borderTop: '1px solid var(--background-modifier-accent, #3f4147)',
  display: 'flex',
  gap: '8px',
  alignItems: 'flex-end',
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  backgroundColor: 'var(--channeltextarea-background, #383a40)',
  border: 'none',
  borderRadius: '6px',
  padding: '8px 10px',
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '13px',
  resize: 'none',
  fontFamily: 'inherit',
  outline: 'none',
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
