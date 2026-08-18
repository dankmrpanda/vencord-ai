import React from 'react';
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

  return (
    <div style={containerStyle}>
      <div style={headerRowStyle}>
        <span style={iconStyle}>{context.isGuild ? '🌐' : context.isDM ? '👤' : '👥'}</span>
        <span style={channelNameStyle}>#{context.channelName}</span>
      </div>
      <div style={scopeTextStyle}>
        <span style={badgeStyle}>Scope</span> {scopeDescription}
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
};

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

const iconStyle: React.CSSProperties = {
  fontSize: '14px',
};

const channelNameStyle: React.CSSProperties = {
  fontWeight: 600,
  color: 'var(--header-primary, #f2f3f5)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const scopeTextStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '11px',
};

const badgeStyle: React.CSSProperties = {
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#ffffff',
  padding: '1px 5px',
  borderRadius: '4px',
  fontWeight: 600,
  fontSize: '10px',
  textTransform: 'uppercase',
};
