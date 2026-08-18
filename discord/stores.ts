import { DiscordChannel, DiscordGuild, DiscordUser } from '../types';

declare global {
  interface Window {
    Vencord?: {
      Webpack?: {
        findByProps: (...props: string[]) => any;
        findByPropsLazy?: (...props: string[]) => any;
        findStore: (name: string) => any;
        Common?: {
          React: typeof import('react');
          ReactDOM: typeof import('react-dom');
          FluxDispatcher: any;
          NavigationRouter?: any;
          RestAPI?: any;
        };
      };
      Plugins?: {
        plugins: Record<string, any>;
      };
      Api?: any;
    };
  }
}

/**
 * Safe accessor for Vencord Webpack finder
 */
export function getWebpack(): any {
  return window.Vencord?.Webpack ?? null;
}

export function findByProps(...props: string[]): any {
  const wp = getWebpack();
  if (!wp) return null;
  return wp.findByProps(...props);
}

export function findStore(name: string): any {
  const wp = getWebpack();
  if (!wp) return null;
  return wp.findStore?.(name) ?? wp.findByProps?.(name);
}

// Lazy Store Getters
export const getSelectedChannelStore = () => findStore('SelectedChannelStore') ?? findByProps('getChannelId', 'getVoiceChannelId');
export const getSelectedGuildStore = () => findStore('SelectedGuildStore') ?? findByProps('getGuildId', 'getLastSelectedGuildId');
export const getChannelStore = () => findStore('ChannelStore') ?? findByProps('getChannel', 'getDMFromUserId');
export const getGuildStore = () => findStore('GuildStore') ?? findByProps('getGuild', 'getGuilds');
export const getUserStore = () => findStore('UserStore') ?? findByProps('getCurrentUser', 'getUser');
export const getRelationshipStore = () => findStore('RelationshipStore') ?? findByProps('getRelationships');
export const getPermissionStore = () => findStore('PermissionStore') ?? findByProps('can');
export const getAuthStore = () => findStore('AuthenticationStore') ?? findByProps('getToken', 'getId');
export const getNavigationUtils = () => findByProps('transitionToGuild', 'transitionTo') ?? findByProps('transitionTo');
export const getHTTP = () => findByProps('get', 'post', 'put', 'del') ?? findByProps('get', 'post');

/**
 * Retrieves the current logged-in Discord user
 */
export function getCurrentUser(): DiscordUser | null {
  try {
    return getUserStore()?.getCurrentUser?.() ?? null;
  } catch (err) {
    console.error('[VencordAI] Error getting current user:', err);
    return null;
  }
}

/**
 * Retrieves the active channel ID
 */
export function getCurrentChannelId(): string | null {
  try {
    return getSelectedChannelStore()?.getChannelId?.() ?? null;
  } catch (err) {
    console.error('[VencordAI] Error getting current channel ID:', err);
    return null;
  }
}

/**
 * Retrieves a channel object by ID
 */
export function getChannel(channelId: string): DiscordChannel | null {
  try {
    return getChannelStore()?.getChannel?.(channelId) ?? null;
  } catch (err) {
    console.error(`[VencordAI] Error getting channel ${channelId}:`, err);
    return null;
  }
}

/**
 * Retrieves a guild object by ID
 */
export function getGuild(guildId: string): DiscordGuild | null {
  try {
    return getGuildStore()?.getGuild?.(guildId) ?? null;
  } catch (err) {
    console.error(`[VencordAI] Error getting guild ${guildId}:`, err);
    return null;
  }
}

/**
 * Retrieves the user's Discord auth token
 */
export function getAuthToken(): string | null {
  try {
    const authStore = getAuthStore();
    return authStore?.getToken?.() ?? null;
  } catch (err) {
    console.error('[VencordAI] Error getting auth token:', err);
    return null;
  }
}

/**
 * Navigates Discord client to a specific guild / channel / message
 */
export function jumpToMessage(channelId: string, messageId: string, guildId?: string): void {
  try {
    const nav = getNavigationUtils();
    if (nav?.transitionToGuild && guildId) {
      nav.transitionToGuild(guildId, channelId, messageId);
      return;
    }
    if (nav?.transitionTo) {
      const path = guildId 
        ? `/channels/${guildId}/${channelId}/${messageId}`
        : `/channels/@me/${channelId}/${messageId}`;
      nav.transitionTo(path);
      return;
    }
    // Fallback: window.location
    const url = guildId 
      ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
      : `https://discord.com/channels/@me/${channelId}/${messageId}`;
    window.open(url, '_blank');
  } catch (err) {
    console.error('[VencordAI] Error jumping to message:', err);
  }
}
