/*
 * Guild permission-limiting and custom-scope boundary tests (DOC-07).
 * Exercises the production code that builds and enforces the guild channel allowlist:
 * getAccessibleGuildChannels / getCurrentScopeContext through a Discord stores mock,
 * and the custom-mode intersection in getPermittedChannelIdsForScope, filterIndexQueryToScope
 * and isChannelAllowedInScope (validateScopeBoundary).
 */

import {
  filterIndexQueryToScope,
  getAccessibleGuildChannels,
  getCurrentScopeContext,
  getPermittedChannelIdsForScope,
  isChannelAllowedInScope,
} from '../discord/scope';
import { ChannelType, CurrentScopeContext, DiscordChannel } from '../types';
import { assert } from './assert';

const GUILD_ID = 'guild_perm_1';
const ACTIVE = 'chan_active';
const ALLOWED = 'chan_allowed';
const DENIED = 'chan_denied';
const VOICE = 'chan_voice';
const STRAY_GDM = 'chan_stray_gdm';

const channels: Record<string, DiscordChannel> = {
  [ACTIVE]: { id: ACTIVE, name: 'general', type: ChannelType.GUILD_TEXT, guild_id: GUILD_ID },
  [ALLOWED]: { id: ALLOWED, name: 'dev', type: ChannelType.GUILD_TEXT, guild_id: GUILD_ID },
  [DENIED]: { id: DENIED, name: 'mods-only', type: ChannelType.GUILD_TEXT, guild_id: GUILD_ID },
  [VOICE]: { id: VOICE, name: 'voice', type: ChannelType.GUILD_VOICE, guild_id: GUILD_ID },
  [STRAY_GDM]: { id: STRAY_GDM, name: 'stray', type: ChannelType.GROUP_DM },
};
let includeStrayGroupDm = false;

/** GuildChannelStore-like shape: grouped `{ channel }` entries plus scalar metadata. */
function guildChannelGroups() {
  return {
    SELECTABLE: [{ channel: channels[ACTIVE] }, { channel: channels[ALLOWED] }, { channel: channels[DENIED] }],
    VOCAL: [{ channel: channels[VOICE] }],
    ...(includeStrayGroupDm ? { PRIVATE: [{ channel: channels[STRAY_GDM] }] } : {}),
    id: GUILD_ID,
    count: 4,
  };
}

/** Grants VIEW only with a literal `true`, and never for DENIED. */
const denyOneStore = { can: (_perm: unknown, channel: DiscordChannel) => channel?.id !== DENIED };

function installStores(permissionStore: unknown): void {
  const stores: Record<string, unknown> = {
    SelectedChannelStore: { getChannelId: () => ACTIVE },
    ChannelStore: {
      getChannel: (id: string) => channels[id] ?? null,
      getChannels: (guildId: string) => (guildId === GUILD_ID ? guildChannelGroups() : null),
    },
    GuildStore: { getGuild: (id: string) => ({ id, name: 'Perm Guild' }) },
    UserStore: {
      getCurrentUser: () => ({ id: 'usr_me', username: 'me' }),
      getUser: (id: string) => ({ id, username: `user_${id}` }),
    },
    PermissionStore: permissionStore,
  };
  (globalThis as any).window = {
    Vencord: {
      Webpack: {
        findStore: (name: string) => stores[name] ?? null,
        findByProps: () => null,
      },
    },
  };
}

function ids(list: { id: string }[] | undefined): string[] {
  return (list ?? []).map((c) => c.id);
}

function customScope(selected: string[]): CurrentScopeContext {
  return {
    channelId: ACTIVE,
    channelName: 'general',
    channelType: ChannelType.GUILD_TEXT,
    isDM: false,
    isGroupDM: false,
    isGuild: true,
    guildId: GUILD_ID,
    accessibleGuildChannels: [
      { id: ACTIVE, name: 'general' },
      { id: ALLOWED, name: 'dev' },
    ],
    scopeMode: 'custom',
    selectedChannelIds: selected,
  };
}

// Mutant G (scope.ts canReadChannel filter ignored): a channel the PermissionStore denies must be excluded.
function caseDeniedChannelExcluded(): boolean {
  installStores(denyOneStore);
  const result = ids(getAccessibleGuildChannels(GUILD_ID));
  return result.includes(ACTIVE) && result.includes(ALLOWED) && !result.includes(DENIED);
}

function caseNonTextChannelExcluded(): boolean {
  installStores({ can: () => true });
  return !ids(getAccessibleGuildChannels(GUILD_ID)).includes(VOICE);
}

// Mutant I (fail-open when PermissionStore is missing) and fail-closed discovery in general.
function caseMissingPermissionStoreFailsClosed(): boolean {
  installStores(null);
  return getAccessibleGuildChannels(GUILD_ID).length === 0;
}

// Mutant I: no PermissionStore must mean no channels, even for an entry that needs no guild permission.
function caseMissingPermissionStoreWithStrayDmFailsClosed(): boolean {
  includeStrayGroupDm = true;
  try {
    installStores(null);
    return getAccessibleGuildChannels(GUILD_ID).length === 0;
  } finally {
    includeStrayGroupDm = false;
  }
}

function caseNonFunctionCanFailsClosed(): boolean {
  installStores({ can: true });
  return getAccessibleGuildChannels(GUILD_ID).length === 0;
}

function caseThrowingCanFailsClosed(): boolean {
  installStores({ can: () => { throw new Error('permission store unavailable'); } });
  return getAccessibleGuildChannels(GUILD_ID).length === 0;
}

// Mutant G through the production context builder.
function caseContextAllowlistIsPermissionLimited(): boolean {
  installStores(denyOneStore);
  const context = getCurrentScopeContext();
  const accessible = ids(context?.accessibleGuildChannels);
  return Boolean(context?.isGuild) && accessible.includes(ALLOWED) && !accessible.includes(DENIED) && !accessible.includes(VOICE);
}

function caseContextWithoutPermissionStoreHasNoGuildChannels(): boolean {
  installStores(null);
  const context = getCurrentScopeContext();
  return Boolean(context?.isGuild) && (context?.accessibleGuildChannels ?? []).length === 0;
}

// Mutant A (guardrails custom mode drops the accessibility check).
function caseCustomSelectedButInaccessibleRejected(): boolean {
  const scope = customScope([ACTIVE, ALLOWED, DENIED]);
  return isChannelAllowedInScope(DENIED, scope) === false && isChannelAllowedInScope(ALLOWED, scope) === true;
}

// Mutant D (custom permitted ids not intersected with accessible channels).
function caseCustomPermittedIdsIntersected(): boolean {
  const permitted = getPermittedChannelIdsForScope(customScope([ACTIVE, ALLOWED, DENIED]));
  return permitted.includes(ALLOWED) && !permitted.includes(DENIED);
}

function caseCustomIndexQueryIntersected(): boolean {
  const scope = customScope([ACTIVE, ALLOWED, DENIED]);
  const unscoped = filterIndexQueryToScope<{ query: string; channelIds?: string[] }>({ query: 'roadmap' }, scope).channelIds ?? [];
  const requested = filterIndexQueryToScope({ query: 'roadmap', channelIds: [DENIED] }, scope).channelIds ?? [];
  return unscoped.includes(ALLOWED) && !unscoped.includes(DENIED) && !requested.includes(DENIED);
}

const CASES: Array<[string, () => boolean]> = [
  ['getAccessibleGuildChannels excludes a channel the PermissionStore denies', caseDeniedChannelExcluded],
  ['getAccessibleGuildChannels excludes non-text channels', caseNonTextChannelExcluded],
  ['getAccessibleGuildChannels fails closed without a PermissionStore', caseMissingPermissionStoreFailsClosed],
  ['getAccessibleGuildChannels fails closed without a PermissionStore for a DM-typed entry', caseMissingPermissionStoreWithStrayDmFailsClosed],
  ['getAccessibleGuildChannels fails closed when PermissionStore.can is not a function', caseNonFunctionCanFailsClosed],
  ['getAccessibleGuildChannels fails closed when PermissionStore.can throws', caseThrowingCanFailsClosed],
  ['getCurrentScopeContext builds a permission-limited guild allowlist', caseContextAllowlistIsPermissionLimited],
  ['getCurrentScopeContext has no guild channels without a PermissionStore', caseContextWithoutPermissionStoreHasNoGuildChannels],
  ['custom scope rejects a selected but inaccessible channel', caseCustomSelectedButInaccessibleRejected],
  ['custom scope permitted ids drop inaccessible selections', caseCustomPermittedIdsIntersected],
  ['custom scope index queries never include inaccessible selections', caseCustomIndexQueryIntersected],
];

export async function runScopePermissionTests(): Promise<void> {
  const hadWindow = 'window' in globalThis;
  const originalWindow = (globalThis as any).window;
  const originalError = console.error;
  let failures = 0;
  try {
    // The throwing-store case logs through console.error by design; keep the run output readable.
    console.error = () => {};
    for (const [name, run] of CASES) {
      let passed = false;
      try {
        passed = run();
      } catch (error) {
        passed = false;
        console.log(`   error in "${name}": ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!passed) failures++;
      console.log(`${passed ? '✅' : '❌'} ${name}`);
    }
  } finally {
    console.error = originalError;
    if (hadWindow) (globalThis as any).window = originalWindow;
    else delete (globalThis as any).window;
  }
  assert(failures === 0, `${failures} scope permission case(s) failed`);
  console.log('✅ Scope permission and custom-scope boundary tests passed');
}
