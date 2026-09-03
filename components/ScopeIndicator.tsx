/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { CurrentScopeContext } from '../types';
import {
  scopeChannelItemStyle,
  scopeChannelListStyle,
  scopeDropdownContainerStyle,
  scopeEditButtonStyle,
  scopeModeActivePillStyle,
  scopeModePillStyle,
  scopeModeRowStyle,
  scopeSearchInputStyle,
} from './sidebarStyles';

interface ScopeIndicatorProps {
  context: CurrentScopeContext | null;
  onScopeChange?: (newScope: CurrentScopeContext) => void;
}

export const ScopeIndicator: React.FC<ScopeIndicatorProps> = ({ context, onScopeChange }) => {
  const [isEditing, setIsEditing] = React.useState(false);
  const [channelFilter, setChannelFilter] = React.useState('');

  if (!context) {
    return (
      <div style={containerStyle}>
        <span style={channelNameStyle}>No active channel selected</span>
      </div>
    );
  }

  const rawName = context.channelName || 'channel';
  const displayName = context.isDM
    ? rawName.startsWith('@') ? rawName : `@${rawName}`
    : rawName.startsWith('#') ? rawName : `#${rawName}`;

  let scopeDescription = 'Current channel only';
  if (context.isGuild) {
    if (context.scopeMode === 'server') {
      const count = context.accessibleGuildChannels?.length ?? 1;
      scopeDescription = `Server-wide (${count} accessible channels in ${context.guildName || 'Server'})`;
    } else if (context.scopeMode === 'custom') {
      const count = context.selectedChannelIds?.length ?? 1;
      scopeDescription = `Custom (${count} selected channel${count > 1 ? 's' : ''} in ${context.guildName || 'Server'})`;
    } else {
      scopeDescription = `Current channel only (${displayName})`;
    }
  } else if (context.isDM) {
    if (context.includeMutualGroupDMs) {
      const gdmCount = context.mutualGroupDMs?.length ?? 0;
      scopeDescription = gdmCount > 0
        ? `DM + ${gdmCount} mutual group chat${gdmCount > 1 ? 's' : ''}`
        : 'Current DM';
    } else {
      scopeDescription = `Current DM only (${displayName})`;
    }
  } else if (context.isGroupDM) {
    scopeDescription = `Current Group DM (${displayName})`;
  }

  const handleGuildModeSelect = (mode: 'channel' | 'server' | 'custom') => {
    if (!onScopeChange) return;
    if (mode === 'channel') {
      onScopeChange({
        ...context,
        scopeMode: 'channel',
        selectedChannelIds: [context.channelId],
      });
    } else if (mode === 'server') {
      onScopeChange({
        ...context,
        scopeMode: 'server',
        selectedChannelIds: (context.accessibleGuildChannels || []).map((c) => c.id),
      });
    } else if (mode === 'custom') {
      const initialIds = context.selectedChannelIds?.length ? context.selectedChannelIds : [context.channelId];
      onScopeChange({
        ...context,
        scopeMode: 'custom',
        selectedChannelIds: initialIds,
      });
    }
  };

  const handleToggleChannel = (channelId: string) => {
    if (!onScopeChange) return;
    const currentSelected = new Set(context.selectedChannelIds || [context.channelId]);
    if (currentSelected.has(channelId)) {
      if (currentSelected.size > 1) {
        currentSelected.delete(channelId);
      }
    } else {
      currentSelected.add(channelId);
    }
    onScopeChange({
      ...context,
      scopeMode: 'custom',
      selectedChannelIds: Array.from(currentSelected),
    });
  };

  const handleToggleDMGroupScope = (include: boolean) => {
    if (!onScopeChange) return;
    onScopeChange({
      ...context,
      includeMutualGroupDMs: include,
    });
  };

  const filteredChannels = (context.accessibleGuildChannels || []).filter((ch) =>
    ch.name.toLowerCase().includes(channelFilter.toLowerCase().trim()),
  );

  const activeGuildMode = context.scopeMode || 'channel';

  return (
    <div style={containerStyle} title={`Active Context: ${displayName} (${scopeDescription})`}>
      <div style={headerRowStyle}>
        <span style={iconStyle}>{context.isGuild ? '🌐' : context.isDM ? '👤' : '👥'}</span>
        <span style={channelNameStyle}>{displayName}</span>
        {onScopeChange && (
          <button
            style={scopeEditButtonStyle}
            onClick={() => setIsEditing(!isEditing)}
            title="Modify active search scope"
          >
            <span>{isEditing ? '▲ Close' : '⚙️ Scope'}</span>
          </button>
        )}
      </div>

      <div style={scopeTextStyle}>
        <span style={badgeStyle}>Scope</span>
        <span style={scopeDescStyle}>{scopeDescription}</span>
      </div>

      {isEditing && (
        <div style={scopeDropdownContainerStyle}>
          {context.isGuild && (
            <>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--header-secondary, #b5bac1)' }}>
                Select Search Scope:
              </div>
              <div style={scopeModeRowStyle}>
                <button
                  style={activeGuildMode === 'channel' ? scopeModeActivePillStyle : scopeModePillStyle}
                  onClick={() => handleGuildModeSelect('channel')}
                >
                  # Current Channel
                </button>
                <button
                  style={activeGuildMode === 'server' ? scopeModeActivePillStyle : scopeModePillStyle}
                  onClick={() => handleGuildModeSelect('server')}
                >
                  🌐 Entire Server
                </button>
                <button
                  style={activeGuildMode === 'custom' ? scopeModeActivePillStyle : scopeModePillStyle}
                  onClick={() => handleGuildModeSelect('custom')}
                >
                  📋 Custom Channels
                </button>
              </div>

              {activeGuildMode === 'custom' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                  <input
                    style={scopeSearchInputStyle}
                    placeholder="Filter channels..."
                    value={channelFilter}
                    onChange={(e) => setChannelFilter(e.target.value)}
                  />
                  <div style={scopeChannelListStyle}>
                    {filteredChannels.length === 0 ? (
                      <div style={{ padding: '6px', fontSize: '11px', color: 'var(--text-muted, #949ba4)' }}>
                        No channels found
                      </div>
                    ) : (
                      filteredChannels.map((c) => {
                        const isChecked = Boolean(context.selectedChannelIds?.includes(c.id));
                        return (
                          <label key={c.id} style={scopeChannelItemStyle}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => handleToggleChannel(c.id)}
                              style={{ cursor: 'pointer', margin: 0 }}
                            />
                            <span>#{c.name}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {context.isDM && (
            <>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--header-secondary, #b5bac1)' }}>
                Select DM Scope:
              </div>
              <div style={scopeModeRowStyle}>
                <button
                  style={!context.includeMutualGroupDMs ? scopeModeActivePillStyle : scopeModePillStyle}
                  onClick={() => handleToggleDMGroupScope(false)}
                >
                  👤 This DM Only
                </button>
                {(context.mutualGroupDMs?.length ?? 0) > 0 && (
                  <button
                    style={context.includeMutualGroupDMs ? scopeModeActivePillStyle : scopeModePillStyle}
                    onClick={() => handleToggleDMGroupScope(true)}
                  >
                    👥 Include Mutual Groups ({context.mutualGroupDMs?.length})
                  </button>
                )}
              </div>
            </>
          )}

          {context.isGroupDM && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted, #949ba4)' }}>
              Group DM scope is restricted to this group chat.
            </div>
          )}
        </div>
      )}
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
