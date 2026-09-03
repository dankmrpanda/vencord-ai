/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export enum ChannelType {
  GUILD_TEXT = 0,
  DM = 1,
  GUILD_VOICE = 2,
  GROUP_DM = 3,
  GUILD_CATEGORY = 4,
  GUILD_ANNOUNCEMENT = 5,
  ANNOUNCEMENT_THREAD = 10,
  PUBLIC_THREAD = 11,
  PRIVATE_THREAD = 12,
  GUILD_STAGE_VOICE = 13,
  GUILD_DIRECTORY = 14,
  GUILD_FORUM = 15,
  GUILD_MEDIA = 16,
}

export interface DiscordUser {
  id: string;
  username: string;
  globalName?: string | null;
  avatar?: string | null;
  discriminator?: string;
  bot?: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url: string;
  content_type?: string;
  width?: number;
  height?: number;
  description?: string;
}

export interface DiscordEmbed {
  title?: string;
  type?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  image?: { url: string; proxy_url?: string; width?: number; height?: number };
  thumbnail?: { url: string; proxy_url?: string; width?: number; height?: number };
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  mentions: DiscordUser[];
  pinned?: boolean;
  type?: number;
  message_reference?: { channel_id?: string; message_id?: string; guild_id?: string };
  referenced_message?: DiscordMessage | null;
  reactions?: Array<{ count: number; me?: boolean; emoji: { id?: string | null; name?: string | null } }>;
  poll?: { question?: { text?: string }; answers?: Array<{ answer_id: number; poll_media?: { text?: string } }>; results?: unknown };
  thread?: DiscordChannel;
  hit?: boolean;
}

export interface DiscordChannel {
  id: string;
  type: ChannelType;
  name?: string;
  topic?: string;
  guild_id?: string;
  recipients?: string[];
  rawRecipients?: any[];
  ownerId?: string;
  parent_id?: string | null;
  last_message_id?: string | null;
  message_count?: number;
  total_message_sent?: number;
  thread_metadata?: { archived?: boolean; archive_timestamp?: string; locked?: boolean; auto_archive_duration?: number };
  applied_tags?: string[];
  available_tags?: Array<{ id: string; name: string; moderated?: boolean; emoji_id?: string | null; emoji_name?: string | null }>;
  isDM?: () => boolean;
  isGroupDM?: () => boolean;
  isGuildText?: () => boolean;
  isThread?: () => boolean;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon?: string | null;
  ownerId: string;
}

export type ProviderPreset =
  | 'omlx'
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'custom';

export interface PluginSettings {
  providerPreset: ProviderPreset;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  enableVision: boolean;
  maxContextMessages: number;
  searchLimitPerQuery: number;
  maxSearchIterations: number;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
      additionalProperties?: boolean;
    };
    strict?: boolean;
  };
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMMessage {
  role: 'developer' | 'system' | 'user' | 'assistant' | 'tool';
  content: any;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
}

export interface ProviderCapabilities {
  strictSchemas: boolean;
  streamingTools: boolean;
  parallelToolCalls: boolean;
  developerMessages: boolean;
  vision: boolean;
}

export interface CompletionRequest {
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface CompletionResult {
  content: string;
  toolCalls?: LLMToolCall[];
  finishReason?: string;
}

export interface ToolExecutionResult<TData = unknown> {
  ok: boolean;
  code: string;
  summary: string;
  untrustedData?: boolean;
  data?: TData;
  citations?: CitationItem[];
  scope?: { channelIds: string[]; guildId?: string };
  pagination?: { nextOffset?: number; nextBeforeMessageId?: string; nextCursor?: string };
  truncation?: { truncated: boolean; returned: number; available?: number };
}

export interface RegisteredTool<TArgs extends Record<string, unknown>, TData = unknown> {
  definition: ToolDefinition;
  parseArgs: (value: unknown) => TArgs;
  isAvailable: (context: CurrentScopeContext, settings: PluginSettings) => boolean;
  timeoutMs: number;
  readOnly: true;
  kind: 'local' | 'discord';
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<ToolExecutionResult<TData>>;
}

export interface ToolExecutionContext {
  scope: CurrentScopeContext;
  settings: PluginSettings;
  signal?: AbortSignal;
  addCitation: (message: DiscordMessage, channelName?: string) => CitationItem;
  analyzeImage: (url: string, question: string, signal?: AbortSignal) => Promise<string>;
}

export interface AgentRunBudget {
  maxModelTurns: number;
  maxToolCalls: number;
  maxElapsedMs: number;
  maxReturnedRecords: number;
  maxEstimatedInputTokens: number;
  finalizationCalls: number;
}

export interface AssistantLaunchRequest {
  targetChannelId: string;
  targetMessageId?: string;
  mode: 'message' | 'thread';
  initialPrompt: string;
}

export interface CitationItem {
  messageId: string;
  channelId: string;
  guildId?: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  timestamp: string;
  channelName?: string;
  attachmentUrls?: string[];
}

export interface AgentStep {
  id: string;
  type: 'thought' | 'tool_call' | 'tool_result' | 'answer' | 'error';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: any;
  timestamp: number;
}

export interface AssistantChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: AgentStep[];
  citations?: CitationItem[];
  timestamp: number;
  isStreaming?: boolean;
}

export interface ChatSession {
  id: string;
  channelId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AssistantChatMessage[];
}

export interface CurrentScopeContext {
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  isDM: boolean;
  isGroupDM: boolean;
  isGuild: boolean;
  guildId?: string;
  guildName?: string;
  currentUser?: DiscordUser;
  otherUser?: DiscordUser;
  mutualGroupDMs?: { id: string; name: string; recipientNames: string[] }[];
  explicitMutualGroupDMIds?: string[];
  accessibleGuildChannels?: { id: string; name: string; topic?: string }[];
  scopeMode?: 'channel' | 'server' | 'custom';
  selectedChannelIds?: string[];
  includeMutualGroupDMs?: boolean;
}
