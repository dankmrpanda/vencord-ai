/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { jumpToMessage } from '../discord/stores';
import { CitationItem } from '../types';

interface MessagePreviewProps {
  citation: CitationItem;
}

export const MessagePreview: React.FC<MessagePreviewProps> = ({ citation }) => {
  const handleJump = () => {
    jumpToMessage(citation.channelId, citation.messageId, citation.guildId);
  };

  const formattedDate = new Date(citation.timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleImageClick = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div style={cardStyle} onClick={handleJump} title="Click to jump to message in Discord">
      <div style={topRowStyle}>
        <div style={authorInfoStyle}>
          {citation.authorAvatar ? (
            <img
              src={citation.authorAvatar}
              alt=""
              style={avatarStyle}
              onError={(e) => {
                (e.target as HTMLElement).style.display = 'none';
              }}
            />
          ) : (
            <div style={defaultAvatarStyle}>
              {citation.authorName ? citation.authorName.charAt(0).toUpperCase() : 'U'}
            </div>
          )}
          <span style={authorNameStyle}>{citation.authorName}</span>
          <span style={timestampStyle}>{formattedDate}</span>
        </div>
        <button
          style={jumpButtonStyle}
          onClick={(e) => {
            e.stopPropagation();
            handleJump();
          }}
          title="Jump to message"
        >
          Jump ↗
        </button>
      </div>

      <div style={contentStyle}>
        {citation.content || <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>[Attachment/Media]</span>}
      </div>

      {citation.attachmentUrls && citation.attachmentUrls.length > 0 && (
        <div style={attachmentContainerStyle}>
          {citation.attachmentUrls.map((url, i) => (
            <img
              key={i}
              src={url}
              alt="attachment"
              style={attachmentThumbStyle}
              title="Click to view full image"
              onClick={(e) => handleImageClick(e, url)}
              onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  borderRadius: '6px',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  padding: '8px 10px',
  margin: '6px 0',
  fontSize: '12px',
  cursor: 'pointer',
  transition: 'background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease',
};

const topRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '4px',
};

const authorInfoStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  overflow: 'hidden',
};

const avatarStyle: React.CSSProperties = {
  width: '18px',
  height: '18px',
  borderRadius: '50%',
  objectFit: 'cover',
  flexShrink: 0,
};

const defaultAvatarStyle: React.CSSProperties = {
  width: '18px',
  height: '18px',
  borderRadius: '50%',
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '10px',
  fontWeight: 'bold',
  flexShrink: 0,
};

const authorNameStyle: React.CSSProperties = {
  fontWeight: 600,
  color: 'var(--header-primary, #f2f3f5)',
  fontSize: '11px',
  maxWidth: '120px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const timestampStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--text-muted, #949ba4)',
};

const jumpButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--text-link, #00a8fc)',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: '3px',
};

const contentStyle: React.CSSProperties = {
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '12px',
  lineHeight: '1.4',
  wordBreak: 'break-word',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

const attachmentContainerStyle: React.CSSProperties = {
  display: 'flex',
  gap: '6px',
  marginTop: '6px',
  flexWrap: 'wrap',
};

const attachmentThumbStyle: React.CSSProperties = {
  maxWidth: '80px',
  maxHeight: '60px',
  borderRadius: '4px',
  objectFit: 'cover',
  cursor: 'zoom-in',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
};
