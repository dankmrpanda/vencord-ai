/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { CurrentScopeContext } from '../types';
import { AtIcon, ChevronDownIcon, HashIcon, ServerIcon, UsersIcon } from './icons';

interface ScopeIndicatorProps {
  context: CurrentScopeContext | null;
  onScopeChange?: (newScope: CurrentScopeContext) => void;
}

/** The short label on the scope chip, e.g. "#general", "All of My Server", "3 channels", "@ord + 2 groups". */
export function scopeChipLabel(context: CurrentScopeContext | null): string {
  if (!context) return 'No conversation open';
  const raw = context.channelName || 'channel';
  if (context.isGuild) {
    if (context.scopeMode === 'server') return `All of ${context.guildName || 'this server'}`;
    if (context.scopeMode === 'custom') {
      const count = context.selectedChannelIds?.length ?? 1;
      return `${count} channel${count === 1 ? '' : 's'}`;
    }
    return raw.startsWith('#') ? raw : `#${raw}`;
  }
  if (context.isDM) {
    const name = raw.startsWith('@') ? raw : `@${raw}`;
    const groups = context.includeMutualGroupDMs ? context.mutualGroupDMs?.length ?? 0 : 0;
    return groups ? `${name} + ${groups} group${groups === 1 ? '' : 's'}` : name;
  }
  return raw;
}

function chipIcon(context: CurrentScopeContext | null): React.ReactNode {
  if (!context) return <HashIcon size={14} />;
  if (context.isGuild) return context.scopeMode === 'server' ? <ServerIcon size={14} /> : <HashIcon size={14} />;
  if (context.isDM) return context.includeMutualGroupDMs ? <UsersIcon size={14} /> : <AtIcon size={14} />;
  return <UsersIcon size={14} />;
}

const Option: React.FC<{ checked: boolean; icon: React.ReactNode; title: string; detail?: string; onSelect: () => void }> = ({
  checked, icon, title, detail, onSelect,
}) => (
  <button className="vai-option" role="menuitemradio" aria-checked={checked} onClick={onSelect}>
    {icon}
    <span>{title}{detail && <small>{detail}</small>}</span>
  </button>
);

/**
 * The search scope as a chip in the composer, like the context chips in other assistants. Opening it lists the
 * scopes the current conversation allows; every choice is still enforced in discord/scope.ts.
 */
export const ScopeIndicator: React.FC<ScopeIndicatorProps> = ({ context, onScopeChange }) => {
  const [open, setOpen] = React.useState(false);
  const [channelFilter, setChannelFilter] = React.useState('');
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Close on a click outside the chip or its popover, and on Escape (marked handled so the panel stays open).
  React.useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const panel = rootRef.current?.closest('#vencord-ai-sidebar-root');
      if (e.target !== document.body && !panel?.contains(e.target as Node)) return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const canEdit = Boolean(context && onScopeChange && !context.isGroupDM);
  const label = scopeChipLabel(context);

  if (!context || !canEdit) {
    return (
      <div className="vai-scope">
        <span className="vai-chip" title={context ? 'Searches only this group DM' : 'Open a channel or DM to ask about it'} style={{ cursor: 'default' }}>
          {chipIcon(context)}<span>{label}</span>
        </span>
      </div>
    );
  }

  const change = (next: CurrentScopeContext) => onScopeChange?.(next);
  const mode = context.scopeMode || 'channel';
  const channels = (context.accessibleGuildChannels || []).filter((ch) =>
    ch.name.toLowerCase().includes(channelFilter.toLowerCase().trim()));

  const toggleChannel = (channelId: string) => {
    const selected = new Set(context.selectedChannelIds || [context.channelId]);
    if (selected.has(channelId)) {
      if (selected.size > 1) selected.delete(channelId);
    } else {
      selected.add(channelId);
    }
    change({ ...context, scopeMode: 'custom', selectedChannelIds: Array.from(selected) });
  };

  return (
    <div className="vai-scope" ref={rootRef}>
      <button
        className="vai-chip"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose where the assistant may search"
      >
        {chipIcon(context)}<span>{label}</span><ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="vai-popover" role="menu" aria-label="Search scope">
          <div className="vai-popover-title">Search in</div>
          {context.isGuild && (
            <>
              <Option
                checked={mode === 'channel'}
                icon={<HashIcon size={16} />}
                title="This channel"
                detail={scopeChipLabel({ ...context, scopeMode: 'channel' })}
                onSelect={() => { change({ ...context, scopeMode: 'channel', selectedChannelIds: [context.channelId] }); setOpen(false); }}
              />
              <Option
                checked={mode === 'server'}
                icon={<ServerIcon size={16} />}
                title="Entire server"
                detail={`${context.accessibleGuildChannels?.length ?? 0} channels you can read`}
                onSelect={() => {
                  change({ ...context, scopeMode: 'server', selectedChannelIds: (context.accessibleGuildChannels || []).map((c) => c.id) });
                  setOpen(false);
                }}
              />
              <Option
                checked={mode === 'custom'}
                icon={<HashIcon size={16} />}
                title="Choose channels"
                detail={mode === 'custom' ? scopeChipLabel(context) : undefined}
                onSelect={() => change({
                  ...context,
                  scopeMode: 'custom',
                  selectedChannelIds: context.selectedChannelIds?.length ? context.selectedChannelIds : [context.channelId],
                })}
              />
              {mode === 'custom' && (
                <>
                  <input
                    className="vai-channel-filter"
                    placeholder="Filter channels"
                    aria-label="Filter channels"
                    value={channelFilter}
                    onChange={(e) => setChannelFilter(e.target.value)}
                  />
                  <div className="vai-channel-list">
                    {channels.length === 0 ? <div className="vai-muted">No channels match.</div> : channels.map((c) => (
                      <label key={c.id} className="vai-channel">
                        <input
                          type="checkbox"
                          checked={Boolean(context.selectedChannelIds?.includes(c.id))}
                          onChange={() => toggleChannel(c.id)}
                        />
                        <span>#{c.name}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {context.isDM && (
            <>
              <Option
                checked={!context.includeMutualGroupDMs}
                icon={<AtIcon size={16} />}
                title="This DM only"
                onSelect={() => { change({ ...context, includeMutualGroupDMs: false }); setOpen(false); }}
              />
              {(context.mutualGroupDMs?.length ?? 0) > 0 && (
                <Option
                  checked={Boolean(context.includeMutualGroupDMs)}
                  icon={<UsersIcon size={16} />}
                  title="Also our group DMs"
                  detail={`${context.mutualGroupDMs?.length} shared group${context.mutualGroupDMs?.length === 1 ? '' : 's'}`}
                  onSelect={() => { change({ ...context, includeMutualGroupDMs: true }); setOpen(false); }}
                />
              )}
              <div className="vai-muted">Or name a group in your question: <em>group Raid Crew</em> or <em>"Raid Crew"</em>.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
