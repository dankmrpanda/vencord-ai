/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { jumpToMessage } from '../discord/stores';
import { CitationItem } from '../types';
import { clickableProps } from './a11y';
import { FileIcon, ImageIcon, JumpIcon } from './icons';

interface MessagePreviewProps {
  citation: CitationItem;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/**
 * UI-Q11: whether an attachment URL can be shown as a thumbnail, and the file name to label it with. Only the last
 * path segment is used, never the query (Discord CDN links carry signed tokens there).
 */
export function attachmentDisplay(url: string): { kind: 'image' | 'file'; name: string } {
  let path = url;
  try { path = new URL(url).pathname; } catch { path = url.split(/[?#]/)[0]; }
  const segment = path.split('/').filter(Boolean).pop() || 'attachment';
  let name = segment;
  try { name = decodeURIComponent(segment); } catch {}
  // Bidi and tag characters could make `invoice<U+202E>fdp.exe` display as `invoiceexe.pdf`.
  name = name.replace(/[؜‎‏‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu, '') || 'attachment';
  return { kind: IMAGE_EXTENSIONS.test(name) ? 'image' : 'file', name };
}

const AttachmentItem: React.FC<{ url: string; onOpen: (e: React.MouseEvent) => void }> = ({ url, onOpen }) => {
  const [failed, setFailed] = React.useState(false);
  const { kind, name } = attachmentDisplay(url);
  if (kind === 'file' || failed) {
    return (
      <button className="vai-file-chip" onClick={onOpen} onKeyDown={(e) => e.stopPropagation()} title={name}>
        {failed ? <><ImageIcon size={12} /> image unavailable</> : <><FileIcon size={12} /> {name}</>}
      </button>
    );
  }
  return <img className="vai-thumb" src={url} alt={name} title="Open image" onClick={onOpen} onError={() => setFailed(true)} />;
};

const initial = (name: string | undefined) => (name ? name.charAt(0).toUpperCase() : '?');

/** Up to three stacked author avatars for a reply's sources. */
export const SourceFaces: React.FC<{ citations: CitationItem[] }> = ({ citations }) => {
  const seen = new Set<string>();
  const faces = citations.filter((c) => {
    const key = c.authorAvatar || c.authorName;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
  return (
    <span className="vai-faces" aria-hidden="true">
      {faces.map((c) => (c.authorAvatar
        ? <img key={c.messageId} src={c.authorAvatar} alt="" />
        : <span key={c.messageId} className="vai-face">{initial(c.authorName)}</span>))}
    </span>
  );
};

/** A cited Discord message, drawn like a compact Discord message; activating it jumps to the original. */
export const MessagePreview: React.FC<MessagePreviewProps> = ({ citation }) => {
  const [avatarFailed, setAvatarFailed] = React.useState(false);
  const handleJump = () => jumpToMessage(citation.channelId, citation.messageId, citation.guildId);
  const when = new Date(citation.timestamp);
  const formattedDate = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const handleOpenAttachment = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="vai-source" {...clickableProps(handleJump)} title="Jump to this message">
      {citation.authorAvatar && !avatarFailed
        ? <img className="vai-source-avatar" src={citation.authorAvatar} alt="" onError={() => setAvatarFailed(true)} />
        : <div className="vai-source-avatar" aria-hidden="true">{initial(citation.authorName)}</div>}
      <div className="vai-source-main">
        <div className="vai-source-meta">
          <span className="vai-source-author">{citation.authorName || 'Unknown'}</span>
          <span className="vai-source-where">{[citation.channelName, formattedDate].filter(Boolean).join(' · ')}</span>
          <span className="vai-source-jump"><JumpIcon size={14} /></span>
        </div>
        <div className="vai-source-text">
          {citation.content || <span className="vai-note">Attachment</span>}
        </div>
        {citation.attachmentUrls && citation.attachmentUrls.length > 0 && (
          <div className="vai-attachments">
            {citation.attachmentUrls.map((url, i) => (
              <AttachmentItem key={i} url={url} onOpen={(e) => handleOpenAttachment(e, url)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
