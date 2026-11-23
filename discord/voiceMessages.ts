/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext, DiscordAttachment, DiscordMessage, ToolExecutionResult } from '../types';
import { DISCORD_CDN_ATTACHMENTS_RE } from './media';
import { fetchOneMessage, isSnowflake } from './rest';
import { isChannelAllowedInScope } from './scope';

/** Discord's message flag for voice messages (IS_VOICE_MESSAGE). */
export const VOICE_MESSAGE_FLAG = 1 << 13;
/** Same limit the VoiceTranscribe service enforces. */
const MAX_VOICE_BYTES = 25 * 1024 * 1024;

/**
 * The native helper of the user's VoiceTranscribe plugin. It downloads only validated Discord CDN URLs, runs speech
 * models on this computer, and keeps its service token in the native process.
 */
export interface VoiceTranscriber {
  prepare(id: string, url: string, token?: string): Promise<void>;
  transcribe(id: string, language: string, token?: string, task?: 'transcribe' | 'translate'): Promise<{
    text: string;
    language: string;
    model: string;
    originalText?: string;
    timings?: { audioSeconds?: number };
  }>;
  release(id: string): Promise<void>;
}

/** The VoiceTranscribe helper when that plugin is built in and enabled; otherwise null (the tool is then not offered). */
export function getVoiceTranscriber(): VoiceTranscriber | null {
  try {
    const w: any = typeof window !== 'undefined' ? window : undefined;
    const helper = w?.VencordNative?.pluginHelpers?.VoiceTranscribe;
    if (!helper || !['prepare', 'transcribe', 'release'].every((name) => typeof helper[name] === 'function')) return null;
    const isEnabled = w?.Vencord?.Plugins?.isPluginEnabled;
    if (typeof isEnabled === 'function' && !isEnabled('VoiceTranscribe')) return null;
    return helper as VoiceTranscriber;
  } catch {
    return null;
  }
}

export function isVoiceMessage(message: Pick<DiscordMessage, 'flags'> | null | undefined): boolean {
  return Boolean((message?.flags ?? 0) & VOICE_MESSAGE_FLAG);
}

/** The audio attachment of a voice message, only if it is a Discord CDN audio file within the size limit. */
export function voiceAttachmentOf(message: DiscordMessage): DiscordAttachment | undefined {
  if (!isVoiceMessage(message)) return undefined;
  return (message.attachments || []).find((attachment) =>
    DISCORD_CDN_ATTACHMENTS_RE.test(attachment.url || '')
    && (attachment.size ?? 0) <= MAX_VOICE_BYTES
    && (!attachment.content_type || attachment.content_type.startsWith('audio/')));
}

export interface VoiceTranscriptData {
  message: DiscordMessage;
  text: string;
  language: string;
  task: 'transcribe' | 'translate';
  originalText?: string;
  durationSeconds?: number;
  model: string;
}

function requestId(): string {
  const c: any = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

/**
 * Transcribes (or translates to English) one scoped voice message with the local VoiceTranscribe service. The audio
 * URL always comes from Discord's own copy of the message, never from the model.
 */
export async function transcribeVoiceMessage(
  scope: CurrentScopeContext,
  channelId: string,
  messageId: string,
  options: { translate?: boolean; language?: string; signal?: AbortSignal; transcriber?: VoiceTranscriber | null } = {},
): Promise<ToolExecutionResult<VoiceTranscriptData>> {
  if (!isChannelAllowedInScope(channelId, scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested message channel is outside the permitted scope.' };
  }
  if (!isSnowflake(messageId)) {
    return { ok: false, code: 'invalid_arguments', summary: 'message_id must be a numeric Discord message ID.' };
  }
  const language = (options.language || '').trim().toLowerCase();
  if (language && !/^[a-z]{2,3}$/.test(language)) {
    return { ok: false, code: 'invalid_arguments', summary: 'language must be a code such as en, es or zh, or left empty.' };
  }
  const transcriber = options.transcriber === undefined ? getVoiceTranscriber() : options.transcriber;
  if (!transcriber) {
    return { ok: false, code: 'unavailable', summary: 'Voice transcription needs the VoiceTranscribe plugin to be enabled.' };
  }

  const message = await fetchOneMessage(channelId, messageId, options.signal);
  if (!message) return { ok: false, code: 'not_found', summary: 'The message was not found, or this account cannot read it.' };
  if (message.channel_id !== channelId) {
    return { ok: false, code: 'scope_denied', summary: 'The returned message does not belong to the requested channel.' };
  }
  const attachment = voiceAttachmentOf(message);
  if (!attachment) {
    return { ok: false, code: 'not_a_voice_message', summary: 'That message is not a voice message, or its audio is unavailable.' };
  }

  const task = options.translate ? 'translate' : 'transcribe';
  const id = requestId();
  const onAbort = () => { void transcriber.release(id).catch(() => {}); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    options.signal?.throwIfAborted();
    await transcriber.prepare(id, attachment.url);
    options.signal?.throwIfAborted();
    const result = await transcriber.transcribe(id, language, '', task);
    const text = String(result?.text ?? '').trim();
    return {
      ok: true,
      code: 'voice_transcript',
      summary: text
        ? `${task === 'translate' ? 'Translated' : 'Transcribed'} one voice message locally (${result.language || 'unknown language'}).`
        : 'The voice message contained no recognizable speech.',
      data: {
        message,
        text,
        language: String(result?.language || ''),
        task,
        originalText: typeof result?.originalText === 'string' ? result.originalText : undefined,
        durationSeconds: Number.isFinite(result?.timings?.audioSeconds) ? result.timings!.audioSeconds : undefined,
        model: String(result?.model || ''),
      },
      scope: { channelIds: [channelId], guildId: scope.guildId },
      truncation: { truncated: false, returned: 1 },
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    void transcriber.release(id).catch(() => {});
  }
}
