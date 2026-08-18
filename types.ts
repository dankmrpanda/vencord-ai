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
  hit?: boolean;
}

export interface DiscordChannel {
  id: string;
  type: ChannelType;
  name?: string;
  topic?: string;
  guild_id?: string;
  recipients?: string[];
  ownerId?: string;
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
    };
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
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
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
  otherUser?: DiscordUser;
  mutualGroupDMs?: { id: string; name: string; recipientNames: string[] }[];
  accessibleGuildChannels?: { id: string; name: string; topic?: string }[];
}
