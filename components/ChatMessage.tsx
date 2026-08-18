import { React } from '@webpack/common';
import { AssistantChatMessage } from '../types';
import { MessagePreview } from './MessagePreview';
import { ToolCallBadge } from './ToolCallBadge';

interface ChatMessageProps {
  message: AssistantChatMessage;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message }) => {
  const isUser = message.role === 'user';

  const toolSteps = message.steps?.filter(
    (s) => s.type === 'tool_call' || s.type === 'tool_result' || s.type === 'error'
  );

  return (
    <div style={isUser ? userContainerStyle : assistantContainerStyle}>
      <div style={headerStyle}>
        <span style={authorBadgeStyle}>{isUser ? 'You' : 'AI Assistant'}</span>
        <span style={timeStyle}>
          {new Date(message.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>

      {/* Tool Call Step Badges */}
      {!isUser && toolSteps && toolSteps.length > 0 && (
        <div style={stepsContainerStyle}>
          {toolSteps.map((step) => (
            <ToolCallBadge key={step.id} step={step} />
          ))}
        </div>
      )}

      {/* Message Content Body */}
      <div style={contentBodyStyle}>
        {message.content}
        {message.isStreaming && <span style={streamingCursorStyle}>▋</span>}
      </div>

      {/* Citation Cards */}
      {!isUser && message.citations && message.citations.length > 0 && (
        <div style={citationsContainerStyle}>
          <div style={citationsHeaderStyle}>
            📌 Referenced Messages ({message.citations.length})
          </div>
          {message.citations.map((c) => (
            <MessagePreview key={c.messageId} citation={c} />
          ))}
        </div>
      )}
    </div>
  );
};

const userContainerStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  borderRadius: '8px',
  padding: '10px 12px',
  margin: '8px 0',
  borderLeft: '3px solid var(--brand-experiment, #5865f2)',
};

const assistantContainerStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-secondary-alt, #232428)',
  borderRadius: '8px',
  padding: '10px 12px',
  margin: '8px 0',
  borderLeft: '3px solid var(--green-360, #23a55a)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '6px',
};

const authorBadgeStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '12px',
  color: 'var(--header-primary, #f2f3f5)',
};

const timeStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted, #949ba4)',
};

const stepsContainerStyle: React.CSSProperties = {
  marginBottom: '8px',
};

const contentBodyStyle: React.CSSProperties = {
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '13px',
  lineHeight: '1.5',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const streamingCursorStyle: React.CSSProperties = {
  display: 'inline-block',
  color: 'var(--brand-experiment, #5865f2)',
  animation: 'blink 1s step-start infinite',
  marginLeft: '2px',
};

const citationsContainerStyle: React.CSSProperties = {
  marginTop: '10px',
  paddingTop: '8px',
  borderTop: '1px solid var(--background-modifier-accent, #3f4147)',
};

const citationsHeaderStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--header-secondary, #b5bac1)',
  marginBottom: '4px',
  textTransform: 'uppercase',
};
