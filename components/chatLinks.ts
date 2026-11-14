/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** What a model-emitted markdown link may do when rendered. Model output is untrusted. */
export type LinkTarget =
  | { kind: 'jump'; href: string; channelId: string; messageId?: string; guildId?: string }
  | { kind: 'external'; href: string; display: string }
  | { kind: 'blocked' };

const DISCORD_HOSTS = ['discord.com', 'discordapp.com'];
const SNOWFLAKE = /^\d{1,20}$/;

function isDiscordHost(hostname: string): boolean {
  return DISCORD_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** `[guild|@me, channel, message?]` -> jump target, or null when the IDs are not Discord IDs. */
function jumpTarget(guild: string | undefined, channelId: string | undefined, messageId: string | undefined, extra: number): LinkTarget | null {
  if (extra > 0 || !channelId || !SNOWFLAKE.test(channelId)) return null;
  if (messageId !== undefined && !SNOWFLAKE.test(messageId)) return null;
  if (guild !== undefined && guild !== '@me' && !SNOWFLAKE.test(guild)) return null;
  const guildId = guild && guild !== '@me' ? guild : undefined;
  const href = `https://discord.com/channels/${guildId ?? '@me'}/${channelId}${messageId ? `/${messageId}` : ''}`;
  return { kind: 'jump', href, channelId, messageId, guildId };
}

/**
 * Classifies a link href. Only Discord jump links (discord://message/..., discord://channels/...,
 * https://discord.com/channels/...) and https: URLs are allowed; https links outside Discord expose their
 * real URL as `display` so the UI never hides the destination behind model-chosen text.
 */
export function classifyLink(rawHref: string): LinkTarget {
  const raw = rawHref.trim();
  let url: URL;
  try {
    url = raw.startsWith('/channels/') ? new URL(raw, 'https://discord.com') : new URL(raw);
  } catch {
    return { kind: 'blocked' };
  }

  if (url.protocol === 'discord:') {
    const [head, ...rest] = [url.hostname.toLowerCase(), ...url.pathname.split('/').filter(Boolean)];
    const target = head === 'message'
      ? jumpTarget(undefined, rest[0], rest[1], rest.length - 2)
      : head === 'channels'
        ? jumpTarget(rest[0], rest[1], rest[2], rest.length - 3)
        : null;
    return target ?? { kind: 'blocked' };
  }

  if (url.protocol !== 'https:') return { kind: 'blocked' };
  // Userinfo can make `https://discord.com@evil.example/` read like a Discord URL; never render or open it.
  url.username = '';
  url.password = '';

  if (isDiscordHost(url.hostname)) {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'channels') {
      const target = jumpTarget(segments[1], segments[2], segments[3], segments.length - 4);
      if (target) return target;
    }
  }
  return { kind: 'external', href: url.href, display: url.href };
}
