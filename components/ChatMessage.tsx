/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { jumpToMessage } from '../discord/stores';
import { AssistantChatMessage } from '../types';
import { classifyChatError } from './chatErrors';
import { classifyLink } from './chatLinks';
import { CheckIcon, ChevronDownIcon, CopyIcon, RetryIcon, SparkleIcon, WarningIcon } from './icons';
import { MessagePreview, SourceFaces } from './MessagePreview';
import { AgentActivity } from './ToolCallBadge';

interface ChatMessageProps {
  message: AssistantChatMessage;
  onOpenSettings?: () => void;
  onRetry?: () => void;
  /** Changes whenever the (in-place mutated) message changes; lets the memoised list skip unchanged rows. */
  version?: string;
}

function renderLink(text: string, rawHref: string, key: number): React.ReactNode {
  const target = classifyLink(rawHref);
  // Model output is untrusted: blocked schemes render as plain text, never as an href (middle-click skips onClick).
  // The destination stays visible as inert text so the user can still read or copy it.
  if (target.kind === 'blocked') {
    const destination = rawHref.trim().slice(0, 200);
    return <span key={key}>{text}{destination && destination !== text ? <> <span className="vai-link-url">({destination})</span></> : null}</span>;
  }

  if (target.kind === 'jump') {
    return (
      <a
        key={key}
        href={target.href}
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
      title={target.href}
      onClick={(e) => {
        e.preventDefault();
        window.open(target.href, '_blank', 'noopener,noreferrer');
      }}
    >
      {text === target.display ? text : <>{renderInlineMarkdown(text)} <span className="vai-link-url">({target.display})</span></>}
    </a>
  );
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(~~([^~]+)~~)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[1]) parts.push(renderLink(match[2], match[3], match.index));
    else if (match[4]) parts.push(<code key={match.index}>{match[5]}</code>);
    else if (match[6]) parts.push(<strong key={match.index}>{renderInlineMarkdown(match[7])}</strong>);
    else if (match[8]) parts.push(<em key={match.index}>{renderInlineMarkdown(match[9])}</em>);
    else if (match[10]) parts.push(<del key={match.index}>{renderInlineMarkdown(match[11])}</del>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
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
    <div className="vai-codeblock">
      <div className="vai-codeblock-head">
        <span>{lang || 'code'}</span>
        <button className="vai-icon-btn vai-small" onClick={handleCopy} title={copied ? 'Copied' : 'Copy code'} aria-label="Copy code">
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
};

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul' | 'ol'; items: string[]; start?: number }
  | { kind: 'h2' | 'h3' | 'h4' | 'quote'; text: string }
  | { kind: 'hr' };

/** Groups lines into paragraphs, lists, headings and quotes, so lists render as real lists. */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const last = () => blocks[blocks.length - 1];
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (/^###\s/.test(line)) blocks.push({ kind: 'h4', text: line.slice(4) });
    else if (/^##\s/.test(line)) blocks.push({ kind: 'h3', text: line.slice(3) });
    else if (/^#\s/.test(line)) blocks.push({ kind: 'h2', text: line.slice(2) });
    else if (/^>\s?/.test(line)) blocks.push({ kind: 'quote', text: line.replace(/^>\s?/, '') });
    else if (/^\s*(---|\*\*\*)\s*$/.test(line)) blocks.push({ kind: 'hr' });
    else if (bullet) {
      const prev = last();
      if (prev?.kind === 'ul') prev.items.push(bullet[1]);
      else blocks.push({ kind: 'ul', items: [bullet[1]] });
    } else if (numbered) {
      const prev = last();
      if (prev?.kind === 'ol') prev.items.push(numbered[2]);
      else blocks.push({ kind: 'ol', items: [numbered[2]], start: Number(numbered[1]) });
    } else if (!line.trim()) {
      blocks.push({ kind: 'p', lines: [] });
    } else {
      const prev = last();
      if (prev?.kind === 'p') prev.lines.push(line);
      else blocks.push({ kind: 'p', lines: [line] });
    }
  }
  return blocks.filter((b) => b.kind !== 'p' || b.lines.length > 0);
}

function renderText(text: string, keyBase: number): React.ReactNode[] {
  return toBlocks(text).map((block, i) => {
    const key = `${keyBase}-${i}`;
    switch (block.kind) {
      case 'h2': return <h2 key={key}>{renderInlineMarkdown(block.text)}</h2>;
      case 'h3': return <h3 key={key}>{renderInlineMarkdown(block.text)}</h3>;
      case 'h4': return <h4 key={key}>{renderInlineMarkdown(block.text)}</h4>;
      case 'quote': return <blockquote key={key}>{renderInlineMarkdown(block.text)}</blockquote>;
      case 'hr': return <hr key={key} />;
      case 'ul': return <ul key={key}>{block.items.map((item, j) => <li key={j}>{renderInlineMarkdown(item)}</li>)}</ul>;
      case 'ol': return <ol key={key} start={block.start}>{block.items.map((item, j) => <li key={j}>{renderInlineMarkdown(item)}</li>)}</ol>;
      default:
        return (
          <p key={key}>
            {block.lines.map((line, j) => <React.Fragment key={j}>{j > 0 && <br />}{renderInlineMarkdown(line)}</React.Fragment>)}
          </p>
        );
    }
  });
}

function renderMarkdownContent(content: string): React.ReactNode {
  if (!content) return null;
  return content.split(/(```[\s\S]*?```)/g).map((block, i) => {
    if (block.startsWith('```') && block.endsWith('```') && block.length >= 6) {
      const inner = block.slice(3, -3);
      const newline = inner.indexOf('\n');
      const lang = newline !== -1 ? inner.slice(0, newline).trim() : '';
      const code = newline !== -1 ? inner.slice(newline + 1) : inner;
      return <CodeBlock key={i} code={code.replace(/\n$/, '')} lang={lang} />;
    }
    return <React.Fragment key={i}>{renderText(block, i)}</React.Fragment>;
  });
}

/** UI-Q05: a reply that finished (stopped or otherwise) without any text. */
export function isEmptyFinishedReply(message: Pick<AssistantChatMessage, 'role' | 'content' | 'isStreaming'>): boolean {
  return message.role !== 'user' && !message.isStreaming && !message.content?.trim();
}

/** The failure text chatService wrote, without its `⚠️ **Error**:` prefix. */
function errorText(content: string): string {
  return content.replace(/^\s*⚠️\s*\*\*Error\*\*:\s*/, '').trim() || 'Something went wrong.';
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const Sources: React.FC<{ message: AssistantChatMessage }> = ({ message }) => {
  const [open, setOpen] = React.useState(false);
  const citations = message.citations || [];
  if (!citations.length) return null;
  return (
    <div className="vai-sources">
      <button
        className="vai-sources-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? 'Hide the messages this answer used' : 'Show the messages this answer used'}
      >
        <SourceFaces citations={citations} />
        <span>{citations.length} source{citations.length === 1 ? '' : 's'}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="vai-source-list">
          {citations.map((c) => <MessagePreview key={c.messageId} citation={c} />)}
        </div>
      )}
    </div>
  );
};

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, onOpenSettings, onRetry }) => {
  const isUser = message.role === 'user';
  // Only a reply chatService marked as an error: model output can imitate the error prefix.
  const errorHint = isUser || !message.isError ? null : classifyChatError(message.content);
  const [copied, setCopied] = React.useState(false);

  if (isUser) {
    return (
      <div className="vai-msg vai-msg-user" title={formatTime(message.timestamp)}>
        <div className="vai-bubble">{message.content}</div>
      </div>
    );
  }

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  const hasText = Boolean(message.content?.trim());

  return (
    <div className="vai-msg">
      <div className="vai-msg-head">
        <div className="vai-avatar"><SparkleIcon size={14} /></div>
        <span className="vai-msg-name">Assistant</span>
        <span className="vai-time">{formatTime(message.timestamp)}</span>
      </div>
      <div className="vai-msg-body">
        <AgentActivity steps={message.steps} streaming={Boolean(message.isStreaming)} hasText={hasText} />

        {message.isError ? (
          // One error card: what failed (chatService's text, without its prefix) and, for known causes, a fixed fix-it hint.
          <div className="vai-error-hint" data-error-kind={errorHint?.kind}>
            <WarningIcon size={16} />
            <div className="vai-error-text">
              <div className="vai-error-title">{errorText(message.content)}</div>
              {errorHint && <div>{errorHint.hint}</div>}
              {errorHint && onOpenSettings && (
                <button className="vai-action vai-outline" onClick={onOpenSettings}>Open settings</button>
              )}
            </div>
          </div>
        ) : (
          <div className="vai-content">
            {renderMarkdownContent(message.content)}
            {isEmptyFinishedReply(message) && <span className="vai-note">Stopped before any answer.</span>}
            {message.isStreaming && hasText && <span className="vai-cursor" aria-hidden="true" />}
          </div>
        )}

        <Sources message={message} />

        {!message.isStreaming && (hasText || onRetry) && (
          <div className="vai-actions">
            {hasText && (
              <button className="vai-action" onClick={handleCopy} title="Copy reply" aria-label="Copy reply">
                {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            {onRetry && (
              <button className="vai-action" onClick={onRetry} title="Ask the previous question again" aria-label="Retry">
                <RetryIcon size={14} />
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** A key for the list's memo: chatService mutates messages in place, so object identity alone cannot tell. */
export function messageVersion(m: AssistantChatMessage): string {
  return [
    m.content.length,
    m.content.slice(-24),
    m.isStreaming ? 1 : 0,
    m.isError ? 1 : 0,
    m.citations?.length ?? 0,
    (m.steps || []).map((s) => `${s.id}:${s.type}:${s.toolResult === undefined ? 0 : 1}`).join(','),
  ].join('|');
}

let memoChatMessage: React.FC<ChatMessageProps> | null = null;

/**
 * Re-renders a row only when its version or its retry availability changes (UI-12). Built on first use, never at
 * import: inside Vencord, `React` from @webpack/common is undefined until Discord's webpack has loaded, and a
 * module-level `React.memo` throws during Vencord's start-up and takes the whole client mod down with it.
 */
export function getMemoChatMessage(): React.FC<ChatMessageProps> {
  if (!memoChatMessage) {
    memoChatMessage = typeof React?.memo === 'function'
      ? React.memo(ChatMessage, (a: ChatMessageProps, b: ChatMessageProps) =>
        a.message === b.message && a.version === b.version && Boolean(a.onRetry) === Boolean(b.onRetry)
        && a.onOpenSettings === b.onOpenSettings)
      : ChatMessage;
  }
  return memoChatMessage;
}
