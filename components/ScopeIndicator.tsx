import { React } from '@webpack/common';
import { CurrentScopeContext } from '../types';

interface ScopeIndicatorProps {
  context: CurrentScopeContext | null;
}

export const ScopeIndicator: React.FC<ScopeIndicatorProps> = ({ context }) => {
  if (!context) {
    return (
      <div style={containerStyle}>
        <span style={channelNameStyle}>No active channel selected</span>
      </div>
    );
  }

  let scopeDescription = 'Current channel only';
  if (context.isGuild) {
    const count = context.accessibleGuildChannels?.length ?? 1;
    scopeDescription = `Server-wide (${count} accessible channels in ${context.guildName || 'Server'})`;
  } else if (context.isDM) {
    const gdmCount = context.mutualGroupDMs?.length ?? 0;
    scopeDescription = gdmCount > 0
      ? `DM + ${gdmCount} mutual group chat${gdmCount > 1 ? 's' : ''}`
      : 'Current DM';
  } else if (context.isGroupDM) {
    scopeDescription = 'Current Group DM';
  }

  const rawName = context.channelName || 'channel';
  const displayName = context.isDM
    ? rawName.startsWith('@') ? rawName : `@${rawName}`
    : rawName.startsWith('#') ? rawName : `#${rawName}`;

  return (
    <div style={containerStyle} title={`Active Context: ${displayName} (${scopeDescription})`}>
      <div style={headerRowStyle}>
        <span style={iconStyle}>{context.isGuild ? '🌐' : context.isDM ? '👤' : '👥'}</span>
        <span style={channelNameStyle}>{displayName}</span>
      </div>
      <div style={scopeTextStyle}>
        <span style={badgeStyle}>Scope</span>
        <span style={scopeDescStyle}>{scopeDescription}</span>
      </div>
    </div>
  );
};

const containerStyle: React.CSSProperties = {
  padding: '8px 12px',
  backgroundColor: 'var(--background-secondary-alt, #232428)',
  borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
  fontSize: '12px',
  color: 'var(--text-muted, #949ba4)',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  flexShrink: 0,
};

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

const iconStyle: React.CSSProperties = {
  fontSize: '13px',
};

const channelNameStyle: React.CSSProperties = {
  fontWeight: 600,
  color: 'var(--header-primary, #f2f3f5)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '13px',
};

const scopeTextStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '11px',
};

const scopeDescStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const badgeStyle: React.CSSProperties = {
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#ffffff',
  padding: '1px 5px',
  borderRadius: '4px',
  fontWeight: 600,
  fontSize: '9px',
  textTransform: 'uppercase',
  flexShrink: 0,
};
