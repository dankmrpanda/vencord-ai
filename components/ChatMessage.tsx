import { React } from '@webpack/common';
import { jumpToMessage } from '../discord/stores';
import { AssistantChatMessage } from '../types';
import { MessagePreview } from './MessagePreview';
import { ToolCallBadge } from './ToolCallBadge';

interface ChatMessageProps {
  message: AssistantChatMessage;
}

/**
 * Handles clicking on markdown links with Discord jump integration
 */
function handleLinkClick(e: React.MouseEvent, href: string) {
  e.preventDefault();
  try {
    // Check for discord web URL: /channels/{guildId or @me}/{channelId}/{messageId}
    const discordMatch = href.match(/discord\.com\/channels\/([^\/]+)\/([^\/]+)\/([^\/]+)/);
    if (discordMatch) {
      const [, guildId, channelId, messageId] = discordMatch;
      jumpToMessage(channelId, messageId, guildId === '@me' ? undefined : guildId);
      return;
    }

    // Check for custom URI scheme: discord://message/{channelId}/{messageId}
    const customMatch = href.match(/discord:\/\/message\/([^\/]+)\/([^\/]+)/);
    if (customMatch) {
      const [, channelId, messageId] = customMatch;
      jumpToMessage(channelId, messageId);
      return;
    }

    window.open(href, '_blank', 'noopener,noreferrer');
  } catch {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Renders inline text with bold, italic, inline code, and clickable links
 */
function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Tokenize inline markdown: links [text](url), inline code `code`, bold **text**, italic *text*
  const regex = /(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // Link [text](url)
      const linkText = match[2];
      const linkHref = match[3];
      parts.push(
        <a
          key={match.index}
          href={linkHref}
          style={linkStyle}
          onClick={(e) => handleLinkClick(e, linkHref)}
          title={linkHref}
        >
          {linkText}
        </a>
      );
    } else if (match[4]) {
      // Inline code `code`
      parts.push(
        <code key={match.index} style={inlineCodeStyle}>
          {match[5]}
        </code>
      );
    } else if (match[6]) {
      // Bold **text**
      parts.push(
        <strong key={match.index} style={{ fontWeight: 700, color: 'var(--header-primary, #f2f3f5)' }}>
          {match[7]}
        </strong>
      );
    } else if (match[8]) {
      // Italic *text*
      parts.push(<em key={match.index}>{match[9]}</em>);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

/**
 * Renders full markdown text including fenced code blocks and paragraphs
 */
function renderMarkdownContent(content: string): React.ReactNode {
  if (!content) return null;

  const segments = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {segments.map((segment, idx) => {
        if (segment.startsWith('```') && segment.endsWith('```')) {
          const inner = segment.slice(3, -3);
          const firstNewline = inner.indexOf('\n');
          const lang = firstNewline !== -1 ? inner.slice(0, firstNewline).trim() : '';
          const code = firstNewline !== -1 ? inner.slice(firstNewline + 1) : inner;

          return (
            <div key={idx} style={codeBlockContainerStyle}>
              {lang && <div style={codeBlockLangStyle}>{lang}</div>}
              <pre style={codeBlockContentStyle}>{code}</pre>
            </div>
          );
        }

        return <span key={idx}>{renderInlineMarkdown(segment)}</span>;
      })}
    </>
  );
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
        {renderMarkdownContent(message.content)}
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

const linkStyle: React.CSSProperties = {
  color: 'var(--text-link, #00a8fc)',
  textDecoration: 'none',
  cursor: 'pointer',
  fontWeight: 500,
};

const inlineCodeStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-floating, #111214)',
  padding: '1px 5px',
  borderRadius: '4px',
  fontSize: '12px',
  fontFamily: 'monospace',
  color: 'var(--text-normal, #dbdee1)',
};

const codeBlockContainerStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-floating, #111214)',
  borderRadius: '6px',
  margin: '6px 0',
  overflow: 'hidden',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
};

const codeBlockLangStyle: React.CSSProperties = {
  padding: '3px 8px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  fontSize: '10px',
  color: 'var(--text-muted, #949ba4)',
  fontWeight: 600,
  textTransform: 'uppercase',
};

const codeBlockContentStyle: React.CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  fontSize: '12px',
  fontFamily: 'monospace',
  color: 'var(--text-normal, #dbdee1)',
  overflowX: 'auto',
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
