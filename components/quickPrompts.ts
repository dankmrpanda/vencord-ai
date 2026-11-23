/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { stripInvisibleAndBidi } from '../discord/guardrails';
import { isImageAttachment } from '../discord/media';
import { VOICE_MESSAGE_FLAG } from '../discord/voiceMessages';
import { ChannelType, CurrentScopeContext, DiscordMessage } from '../types';

export type QuickPromptIconKind =
  | 'messages'
  | 'link'
  | 'search'
  | 'image'
  | 'pin'
  | 'thread'
  | 'mic'
  | 'users'
  | 'sparkle';

export interface QuickPromptItem {
  id: string;
  icon: QuickPromptIconKind;
  label: string;
  prompt: string;
  group: 'general' | 'tailored';
}

function cleanLabelText(value: string | undefined, max = 26): string {
  const cleaned = stripInvisibleAndBidi(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function detectLiveSignalPrompts(
  scope: CurrentScopeContext | null,
  recentMessages: DiscordMessage[],
  enableVision: boolean,
  hasVoiceTranscribe: boolean,
): QuickPromptItem[] {
  if (!recentMessages.length) return [];
  const window = recentMessages.slice(-20);
  const boosts: QuickPromptItem[] = [];

  if (hasVoiceTranscribe) {
    const voice = [...window].reverse().find((m) => Boolean((m.flags ?? 0) & VOICE_MESSAGE_FLAG));
    if (voice) {
      boosts.push({
        id: 'live-voice',
        icon: 'mic',
        label: 'Transcribe the latest voice note',
        prompt: `Transcribe the latest voice message (${voice.id}) in this conversation and summarize its key points.`,
        group: 'tailored',
      });
    }
  }

  if (enableVision) {
    const withImage = [...window].reverse().find((m) =>
      m.attachments?.some((a) => isImageAttachment(a)) ||
      m.embeds?.some((e) => Boolean(e.image?.url)),
    );
    if (withImage) {
      boosts.push({
        id: 'live-image',
        icon: 'image',
        label: 'Explain the latest shared image',
        prompt: `Inspect the image in message ${withImage.id} and explain what it shows or says.`,
        group: 'tailored',
      });
    }
  }

  const poll = [...window].reverse().find((m) => Boolean(m.poll?.question?.text));
  if (poll) {
    boosts.push({
      id: 'live-poll',
      icon: 'sparkle',
      label: 'Summarize the active poll & opinions',
      prompt: 'Summarize the recent poll and what people are saying about the options.',
      group: 'tailored',
    });
  }

  const codeMsg = [...window].reverse().find((m) => /```[\s\S]+```/.test(m.content || ''));
  if (codeMsg) {
    boosts.push({
      id: 'live-code',
      icon: 'search',
      label: 'Explain the recent code / error snippet',
      prompt: 'Look at the code or error snippet shared recently and explain what is happening and how to fix it.',
      group: 'tailored',
    });
  }

  const currentUserId = scope?.currentUser?.id;
  const questionFromOther = [...window].reverse().find(
    (m) => m.author?.id !== currentUserId && /\?\s*$/.test((m.content || '').trim()) && (m.content || '').length >= 12,
  );
  if (questionFromOther) {
    const sender = cleanLabelText(questionFromOther.author?.globalName || questionFromOther.author?.username, 18);
    boosts.push({
      id: 'live-reply-question',
      icon: 'sparkle',
      label: sender ? `Draft a reply to ${sender}'s question` : 'Draft a reply to the latest question',
      prompt: `Look at the recent question from ${sender || 'the other person'} and help me draft a clear, helpful reply grounded in our chat.`,
      group: 'tailored',
    });
  }

  return boosts;
}

function defaultTailoredForScope(scope: CurrentScopeContext | null): QuickPromptItem[] {
  if (!scope) {
    return [
      {
        id: 'fallback-topics',
        icon: 'search',
        label: 'What were the main topics today?',
        prompt: 'What were the main topics discussed here today?',
        group: 'tailored',
      },
      {
        id: 'fallback-pins',
        icon: 'pin',
        label: 'Check pinned messages',
        prompt: 'Check the pinned messages here and summarize the most important ones.',
        group: 'tailored',
      },
      {
        id: 'fallback-reply',
        icon: 'sparkle',
        label: 'Help me draft a reply',
        prompt: 'Based on the recent conversation here, help me draft a clear reply.',
        group: 'tailored',
      },
    ];
  }

  if (scope.isDM) {
    const partner = cleanLabelText(scope.otherUser?.globalName || scope.otherUser?.username || scope.channelName.replace(/^@/, ''), 20) || 'them';
    return [
      {
        id: 'dm-partner-asks',
        icon: 'messages',
        label: `What did ${partner} ask or need?`,
        prompt: `What did ${partner} ask about or need from me recently? Cite the relevant messages.`,
        group: 'tailored',
      },
      {
        id: 'dm-plans',
        icon: 'search',
        label: 'Any plans, dates, or commitments?',
        prompt: `Find any upcoming plans, dates, times, or commitments ${partner} and I discussed recently.`,
        group: 'tailored',
      },
      {
        id: 'dm-reply',
        icon: 'sparkle',
        label: `Draft a reply to ${partner}`,
        prompt: `Read ${partner}'s latest messages and help me draft a concise, natural reply.`,
        group: 'tailored',
      },
    ];
  }

  if (scope.isGroupDM) {
    return [
      {
        id: 'gdm-plans',
        icon: 'users',
        label: 'What plans or decisions were made?',
        prompt: 'Summarize the plans, decisions, and who agreed to what in this group chat recently.',
        group: 'tailored',
      },
      {
        id: 'gdm-topics',
        icon: 'search',
        label: 'Main topics from today',
        prompt: 'What were the main topics discussed in this group chat today?',
        group: 'tailored',
      },
      {
        id: 'gdm-reply',
        icon: 'sparkle',
        label: 'Draft a reply to the group',
        prompt: 'Based on the latest messages in this group chat, help me draft a helpful reply.',
        group: 'tailored',
      },
    ];
  }

  if (scope.channelType === ChannelType.GUILD_FORUM || scope.channelType === ChannelType.GUILD_MEDIA) {
    const ch = cleanLabelText(scope.channelName, 20) || 'this forum';
    return [
      {
        id: 'forum-active',
        icon: 'thread',
        label: `Summarize active posts in #${ch}`,
        prompt: `List and summarize the active posts in #${ch}, including key takeaways.`,
        group: 'tailored',
      },
      {
        id: 'forum-questions',
        icon: 'search',
        label: 'Posts with open questions',
        prompt: `Which posts in #${ch} still have open questions or need follow-up?`,
        group: 'tailored',
      },
      {
        id: 'forum-solutions',
        icon: 'pin',
        label: 'Best solutions & resources',
        prompt: `Find the most useful solutions, guides, or links shared across #${ch}.`,
        group: 'tailored',
      },
    ];
  }

  const isThread =
    scope.channelType === ChannelType.PUBLIC_THREAD ||
    scope.channelType === ChannelType.PRIVATE_THREAD ||
    scope.channelType === ChannelType.ANNOUNCEMENT_THREAD;
  if (isThread) {
    return [
      {
        id: 'thread-summary',
        icon: 'thread',
        label: 'Summarize this thread & outcome',
        prompt: 'Summarize this thread from the start, including the main conclusion or status.',
        group: 'tailored',
      },
      {
        id: 'thread-actions',
        icon: 'search',
        label: 'Action items & open questions',
        prompt: 'What action items, blockers, or open questions remain in this thread?',
        group: 'tailored',
      },
      {
        id: 'thread-key-msgs',
        icon: 'pin',
        label: 'Key messages to jump to',
        prompt: 'List the most important messages in this thread with jump links.',
        group: 'tailored',
      },
    ];
  }

  if (scope.scopeMode === 'server') {
    const guild = cleanLabelText(scope.guildName, 22) || 'this server';
    return [
      {
        id: 'server-today',
        icon: 'search',
        label: `What's happening in ${guild} today?`,
        prompt: `Search across ${guild} for the main discussions and updates from today.`,
        group: 'tailored',
      },
      {
        id: 'server-announcements',
        icon: 'pin',
        label: 'Recent announcements & updates',
        prompt: `Find recent announcements, releases, or important updates in ${guild}.`,
        group: 'tailored',
      },
      {
        id: 'server-threads',
        icon: 'thread',
        label: 'Active threads worth reading',
        prompt: `List the active threads in ${guild} and summarize what each is about.`,
        group: 'tailored',
      },
    ];
  }

  // Guild text / announcement channel: tailor by channel name & topic keywords
  const chName = cleanLabelText(scope.channelName, 20) || 'channel';
  const topicText = `${scope.channelName || ''} ${scope.channelTopic || ''}`.toLowerCase();

  if (/\b(dev|code|bug|bugs|help|support|tech|engineering|api|issue|issues|debug)\b/.test(topicText)) {
    return [
      {
        id: 'dev-bugs',
        icon: 'search',
        label: `Recent bugs & issues in #${chName}`,
        prompt: `What bugs, errors, or technical issues were discussed in #${chName} recently?`,
        group: 'tailored',
      },
      {
        id: 'dev-fixes',
        icon: 'pin',
        label: 'Fixes & workarounds shared',
        prompt: `What solutions, fixes, or workarounds were found in #${chName} recently? Check pins and threads too.`,
        group: 'tailored',
      },
      {
        id: 'dev-open',
        icon: 'thread',
        label: 'Unresolved questions here',
        prompt: `Are there any unanswered questions or active help threads in #${chName}?`,
        group: 'tailored',
      },
    ];
  }

  if (scope.channelType === ChannelType.GUILD_ANNOUNCEMENT || /\b(announce|news|updates|changelog|release|releases|rules)\b/.test(topicText)) {
    return [
      {
        id: 'ann-latest',
        icon: 'pin',
        label: 'Latest announcements & takeaways',
        prompt: `Summarize the most recent announcements and pinned posts in #${chName}.`,
        group: 'tailored',
      },
      {
        id: 'ann-changes',
        icon: 'search',
        label: 'Important dates & changes',
        prompt: `List any upcoming dates, deadlines, or rule/feature changes mentioned in #${chName}.`,
        group: 'tailored',
      },
      {
        id: 'ann-links',
        icon: 'link',
        label: 'Official links & resources',
        prompt: `Collect the important links and resources posted in #${chName}.`,
        group: 'tailored',
      },
    ];
  }

  return [
    {
      id: 'guild-decisions',
      icon: 'search',
      label: `Action items & decisions in #${chName}`,
      prompt: `What decisions, action items, or open questions came up in #${chName} recently?`,
      group: 'tailored',
    },
    {
      id: 'guild-pins-threads',
      icon: 'pin',
      label: 'Check pinned info & active threads',
      prompt: `Check the pinned messages and active threads in #${chName} and summarize what matters.`,
      group: 'tailored',
    },
    {
      id: 'guild-reply',
      icon: 'sparkle',
      label: 'Help me draft a reply here',
      prompt: `Read the latest conversation in #${chName} and help me draft a clear, relevant reply.`,
      group: 'tailored',
    },
  ];
}

/**
 * Builds empty-state quick prompts: always 2 general default prompts + 3 prompts tailored
 * to the active channel/DM/thread/forum and live loaded messages.
 */
export function buildEmptyStateQuickPrompts(
  scope: CurrentScopeContext | null,
  options: {
    recentMessages?: DiscordMessage[];
    enableVision?: boolean;
    hasVoiceTranscribe?: boolean;
  } = {},
): { general: QuickPromptItem[]; tailored: QuickPromptItem[] } {
  const where = scope?.isDM || scope?.isGroupDM ? 'in this DM' : 'here';
  const general: QuickPromptItem[] = [
    {
      id: 'general-catch-up',
      icon: 'messages',
      label: 'Catch me up on recent messages',
      prompt: `Catch me up on the recent conversation ${where} — main topics, decisions, and anything I missed.`,
      group: 'general',
    },
    {
      id: 'general-media',
      icon: 'link',
      label: 'Find links, images & files shared',
      prompt: `Find the links, images, and files shared ${where} recently.`,
      group: 'general',
    },
  ];

  const baseTailored = defaultTailoredForScope(scope);
  const liveBoosts = detectLiveSignalPrompts(
    scope,
    options.recentMessages || [],
    Boolean(options.enableVision),
    Boolean(options.hasVoiceTranscribe),
  );

  // Merge up to 2 live signals ahead of the default tailored prompts, keeping exactly 3 tailored items.
  const tailored: QuickPromptItem[] = [];
  const seenIds = new Set<string>();
  for (const item of [...liveBoosts.slice(0, 2), ...baseTailored]) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    tailored.push(item);
    if (tailored.length === 3) break;
  }

  return { general, tailored };
}
