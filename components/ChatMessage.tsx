/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { jumpToMessage } from '../discord/stores';
import { AssistantChatMessage } from '../types';
import { clickableProps } from './a11y';
import { classifyChatError } from './chatErrors';
import { classifyLink } from './chatLinks';
import { MessagePreview } from './MessagePreview';
import { ToolCallBadge } from './ToolCallBadge';

interface ChatMessageProps {
  message: AssistantChatMessage;
  onOpenSettings?: () => void;
  onRetry?: () => void;
}

function renderLink(text: string, rawHref: string, key: number): React.ReactNode {
  const target = classifyLink(rawHref);
  // Model output is untrusted: blocked schemes render as plain text, never as an href (middle-click skips onClick).
  // The destination stays visible as inert text so the user can still read or copy it.
  if (target.kind === 'blocked') {
    const destination = rawHref.trim().slice(0, 200);
    return <span key={key}>{text}{destination && destination !== text ? <> <span style={linkUrlStyle}>({destination})</span></> : null}</span>;
  }

  if (target.kind === 'jump') {
    return (
      <a
        key={key}
        href={target.href}
        style={linkStyle}
        title={target.href}
        onClick={(e) => {
          e.preventDefault();
          jumpToMessage(target.channelId, target.messageId, target.guildId);
        }}
      >
        {renderInlineMarkdown(text)}
      </a>
    );
  }

  // External https link: show the real URL next to the model-chosen text.
  return (
    <a
      key={key}
      href={target.href}
      target="_blank"
      rel="noopener noreferrer"
      style={linkStyle}
      title={target.href}
      onClick={(e) => {
        e.preventDefault();
        window.open(target.href, '_blank', 'noopener,noreferrer');
      }}
    >
      {text === target.display ? text : <>{renderInlineMarkdown(text)} <span style={linkUrlStyle}>({target.display})</span></>}
    </a>
  );
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(~~([^~]+)~~)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      parts.push(renderLink(match[2], match[3], match.index));
    } else if (match[4]) {
      parts.push(
        <code key={match.index} style={inlineCodeStyle}>
          {match[5]}
        </code>
      );
    } else if (match[6]) {
      parts.push(
        <strong key={match.index} style={{ fontWeight: 700, color: 'var(--header-primary, #f2f3f5)' }}>
          {renderInlineMarkdown(match[7])}
        </strong>
      );
    } else if (match[8]) {
      parts.push(<em key={match.index}>{renderInlineMarkdown(match[9])}</em>);
    } else if (match[10]) {
      parts.push(<del key={match.index}>{renderInlineMarkdown(match[11])}</del>);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

const CodeBlock: React.FC<{ code: string; lang: string }> = ({ code, lang }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div style={codeBlockContainerStyle}>
      <div style={codeBlockHeaderStyle}>
        <span style={codeBlockLangStyle}>{lang || 'CODE'}</span>
        <button style={copyCodeButtonStyle} onClick={handleCopy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre style={codeBlockContentStyle}>{code}</pre>
    </div>
  );
};

function renderMarkdownContent(content: string): React.ReactNode {
  if (!content) return null;

  const codeSplit = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {codeSplit.map((block, bIdx) => {
        if (block.startsWith('```') && block.endsWith('```')) {
          const inner = block.slice(3, -3);
          const firstNewline = inner.indexOf('\n');
          const lang = firstNewline !== -1 ? inner.slice(0, firstNewline).trim() : '';
          const code = firstNewline !== -1 ? inner.slice(firstNewline + 1) : inner;
          return <CodeBlock key={bIdx} code={code} lang={lang} />;
        }

        return (
          <div key={bIdx}>
            {block.split('\n').map((line, lIdx) => {
              if (line.startsWith('### ')) return <h4 key={lIdx} style={h4Style}>{renderInlineMarkdown(line.slice(4))}</h4>;
              if (line.startsWith('## ')) return <h3 key={lIdx} style={h3Style}>{renderInlineMarkdown(line.slice(3))}</h3>;
              if (line.startsWith('# ')) return <h2 key={lIdx} style={h2Style}>{renderInlineMarkdown(line.slice(2))}</h2>;
              if (line.startsWith('> ')) return <blockquote key={lIdx} style={blockquoteStyle}>{renderInlineMarkdown(line.slice(2))}</blockquote>;
              if (line.startsWith('- ') || line.startsWith('* ')) {
                return (
                  <div key={lIdx} style={listItemStyle}>
                    <span style={bulletStyle}>•</span>
                    <span>{renderInlineMarkdown(line.slice(2))}</span>
                  </div>
                );
              }
              const numMatch = line.match(/^(\d+)\.\s+(.*)/);
              if (numMatch) {
                return (
                  <div key={lIdx} style={listItemStyle}>
                    <span style={numBulletStyle}>{numMatch[1]}.</span>
                    <span>{renderInlineMarkdown(numMatch[2])}</span>
                  </div>
                );
              }
              if (line.trim() === '---' || line.trim() === '***') return <hr key={lIdx} style={hrStyle} />;

              return (
                <div key={lIdx} style={paragraphLineStyle}>
                  {line ? renderInlineMarkdown(line) : <div style={{ height: '6px' }} />}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/** UI-Q05: a reply that finished (stopped or otherwise) without any text. */
export function isEmptyFinishedReply(message: Pick<AssistantChatMessage, 'role' | 'content' | 'isStreaming'>): boolean {
  return message.role !== 'user' && !message.isStreaming && !message.content?.trim();
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, onOpenSettings, onRetry }) => {
  const isUser = message.role === 'user';
  // Only a reply chatService marked as an error: model output can imitate the error prefix.
  const errorHint = isUser || !message.isError ? null : classifyChatError(message.content);
  const [copiedMsg, setCopiedMsg] = React.useState(false);
  const [showCitations, setShowCitations] = React.useState(false);

  const toolSteps = message.steps?.filter(
    (s) => s.type === 'tool_call' || s.type === 'tool_result' || s.type === 'error'
  );

  const handleCopyMessage = () => {
    try {
      navigator.clipboard.writeText(message.content);
      setCopiedMsg(true);
      setTimeout(() => setCopiedMsg(false), 2000);
    } catch {}
  };

  return (
    <div style={isUser ? userContainerStyle : assistantContainerStyle}>
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={authorBadgeStyle}>{isUser ? '👤 You' : '🤖 AI Assistant'}</span>
          <span style={timeStyle}>
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {!isUser && onRetry && (
            <button style={copyMessageButtonStyle} onClick={onRetry} title="Ask the previous question again">
              ↻ Retry
            </button>
          )}
          {!isUser && message.content && (
            <button style={copyMessageButtonStyle} onClick={handleCopyMessage} title="Copy reply">
              {copiedMsg ? '✓ Copied' : '📋 Copy'}
            </button>
          )}
        </div>
      </div>

      {!isUser && toolSteps && toolSteps.length > 0 && (
        <div style={stepsContainerStyle}>
          {toolSteps.map((step) => (
            <ToolCallBadge key={step.id} step={step} />
          ))}
        </div>
      )}

      <div style={contentBodyStyle}>
        {renderMarkdownContent(message.content)}
        {isEmptyFinishedReply(message) && <em style={timeStyle}>Stopped before any answer.</em>}
        {message.isStreaming && <span style={streamingCursorStyle}>▋</span>}
      </div>

      {errorHint && (
        <div style={errorHintStyle} data-error-kind={errorHint.kind}>
          <span>💡 {errorHint.hint}</span>
          {onOpenSettings && (
            <button style={copyMessageButtonStyle} onClick={onOpenSettings}>
              Open settings
            </button>
          )}
        </div>
      )}

      {!isUser && message.citations && message.citations.length > 0 && (
        <div style={citationsContainerStyle}>
          <div
            style={citationsHeaderStyle}
            {...clickableProps(() => setShowCitations(!showCitations), showCitations)}
            title={showCitations ? 'Click to hide references' : 'Click to show references'}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>📌</span>
              <span>Referenced Messages ({message.citations.length})</span>
            </div>
            <div style={citationsToggleStyle}>
              <span style={{ fontSize: '10px' }}>{showCitations ? 'Hide' : 'Show'}</span>
              <span style={{ fontSize: '9px' }}>{showCitations ? '▲' : '▼'}</span>
            </div>
          </div>
          {showCitations && (
            <div style={citationsListStyle}>
              {message.citations.map((c) => (
                <MessagePreview key={c.messageId} citation={c} />
              ))}
            </div>
          )}
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

const copyMessageButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--interactive-normal, #b5bac1)',
  fontSize: '11px',
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: '4px',
};

const errorHintStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  marginTop: '6px',
  padding: '6px 8px',
  borderRadius: '4px',
  fontSize: '12px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  color: 'var(--text-normal, #dbdee1)',
};

const stepsContainerStyle: React.CSSProperties = {
  marginBottom: '8px',
};

const contentBodyStyle: React.CSSProperties = {
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '13px',
  lineHeight: '1.5',
  wordBreak: 'break-word',
};

const paragraphLineStyle: React.CSSProperties = {
  minHeight: '18px',
};

const h2Style: React.CSSProperties = {
  fontSize: '16px',
  fontWeight: 700,
  color: 'var(--header-primary, #f2f3f5)',
  margin: '10px 0 4px 0',
};

const h3Style: React.CSSProperties = {
  fontSize: '14px',
  fontWeight: 600,
  color: 'var(--header-primary, #f2f3f5)',
  margin: '8px 0 4px 0',
};

const h4Style: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--header-secondary, #b5bac1)',
  margin: '6px 0 2px 0',
};

const blockquoteStyle: React.CSSProperties = {
  margin: '4px 0',
  paddingLeft: '10px',
  borderLeft: '3px solid var(--background-modifier-accent, #4e5058)',
  color: 'var(--text-muted, #949ba4)',
  fontStyle: 'italic',
};

const listItemStyle: React.CSSProperties = {
  display: 'flex',
  gap: '6px',
  margin: '2px 0',
  paddingLeft: '4px',
};

const bulletStyle: React.CSSProperties = {
  color: 'var(--brand-experiment, #5865f2)',
  fontWeight: 'bold',
};

const numBulletStyle: React.CSSProperties = {
  color: 'var(--header-secondary, #b5bac1)',
  fontWeight: 600,
  minWidth: '16px',
};

const hrStyle: React.CSSProperties = {
  border: 'none',
  borderTop: '1px solid var(--background-modifier-accent, #3f4147)',
  margin: '10px 0',
};

const linkStyle: React.CSSProperties = {
  color: 'var(--text-link, #00a8fc)',
  textDecoration: 'none',
  cursor: 'pointer',
  fontWeight: 500,
};

const linkUrlStyle: React.CSSProperties = {
  color: 'var(--text-muted, #949ba4)',
  fontWeight: 400,
  wordBreak: 'break-all',
};

const inlineCodeStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-floating, #111214)',
  padding: '1px 5px',
  borderRadius: '4px',
  fontSize: '12px',
  fontFamily: 'monospace',
  color: 'var(--text-normal, #dbdee1)',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
};

const codeBlockContainerStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-floating, #111214)',
  borderRadius: '6px',
  margin: '8px 0',
  overflow: 'hidden',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
};

const codeBlockHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '4px 10px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
};

const codeBlockLangStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--text-muted, #949ba4)',
  fontWeight: 600,
  textTransform: 'uppercase',
};

const copyCodeButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--interactive-normal, #b5bac1)',
  fontSize: '10px',
  fontWeight: 600,
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: '3px',
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
  animation: 'vencord-ai-blink 1s step-start infinite',
  marginLeft: '2px',
  fontWeight: 'bold',
};

const citationsContainerStyle: React.CSSProperties = {
  marginTop: '10px',
  paddingTop: '6px',
  borderTop: '1px solid var(--background-modifier-accent, #3f4147)',
};

const citationsHeaderStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--header-secondary, #b5bac1)',
  marginBottom: '4px',
  textTransform: 'uppercase',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  cursor: 'pointer',
  userSelect: 'none',
  padding: '4px 6px',
  borderRadius: '4px',
  backgroundColor: 'var(--background-secondary, rgba(0, 0, 0, 0.15))',
  transition: 'background-color 0.15s ease, color 0.15s ease',
};

const citationsToggleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  color: 'var(--text-muted, #949ba4)',
  fontWeight: 500,
};

const citationsListStyle: React.CSSProperties = {
  marginTop: '4px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
};
