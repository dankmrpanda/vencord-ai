/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  fetchRecentMessages,
  fetchSurroundingMessages,
  formatMessageForLLM,
} from '../discord/messages';
import { getCurrentScopeContext, isChannelAllowedInScope } from '../discord/scope';
import { searchDiscordMessages } from '../discord/search';
import { getChannel } from '../discord/stores';
import {
  AgentStep,
  AssistantChatMessage,
  CitationItem,
  CurrentScopeContext,
  DiscordMessage,
  LLMMessage,
  PluginSettings,
} from '../types';
import { AGENT_TOOLS, DEFAULT_SYSTEM_PROMPT } from './prompts';
import { OpenAICompatibleClient } from './provider';

export interface AgentRunCallbacks {
  onStepAdded?: (step: AgentStep) => void;
  onStepUpdated?: (step: AgentStep) => void;
  onToken?: (token: string) => void;
  onCitationsUpdated?: (citations: CitationItem[]) => void;
}

export class AIAssistantAgent {
  private client: OpenAICompatibleClient;
  private settings: PluginSettings;

  constructor(settings: PluginSettings) {
    this.settings = settings;
    this.client = new OpenAICompatibleClient(settings);
  }

  public updateSettings(settings: PluginSettings) {
    this.settings = settings;
    this.client.updateSettings(settings);
  }

  /**
   * Runs the full agent loop for a user query
   */
  public async run(
    userPrompt: string,
    history: AssistantChatMessage[],
    callbacks?: AgentRunCallbacks,
    signal?: AbortSignal
  ): Promise<{ content: string; steps: AgentStep[]; citations: CitationItem[] }> {
    const steps: AgentStep[] = [];
    const citations: CitationItem[] = [];
    const citationMap = new Map<string, CitationItem>();

    const currentScope = getCurrentScopeContext();
    if (!currentScope) {
      throw new Error('Could not determine current Discord channel context.');
    }

    const addCitation = (msg: DiscordMessage, channelName?: string) => {
      if (!citationMap.has(msg.id)) {
        const channel = getChannel(msg.channel_id);
        const resolvedGuildId =
          msg.guild_id || channel?.guild_id || (currentScope.isGuild ? currentScope.guildId : undefined);
        const resolvedChannelName = channelName || channel?.name || currentScope.channelName;

        const item: CitationItem = {
          messageId: msg.id,
          channelId: msg.channel_id,
          guildId: resolvedGuildId,
          authorName: msg.author?.globalName || msg.author?.username || 'User',
          authorAvatar: msg.author?.avatar
            ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png`
            : undefined,
          content: msg.content || (msg.attachments?.length ? `[${msg.attachments[0].filename}]` : ''),
          timestamp: msg.timestamp,
          channelName: resolvedChannelName || 'channel',
          attachmentUrls: msg.attachments?.map((a) => a.url),
        };
        citationMap.set(msg.id, item);
        callbacks?.onCitationsUpdated?.(Array.from(citationMap.values()));
      }
    };

    // Build LLM message sequence
    const systemPrompt = this.settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    const llmMessages: LLMMessage[] = [
      {
        role: 'system',
        content: `${systemPrompt}\n\n[Active Scope Context]: Channel: #${currentScope.channelName} (${currentScope.channelId}), Type: ${currentScope.isDM ? 'Direct Message' : currentScope.isGroupDM ? 'Group DM' : `Server Guild (${currentScope.guildName || currentScope.guildId})`}`,
      },
    ];

    // Include recent session history
    const recentHistory = history.slice(-6);
    for (const item of recentHistory) {
      if (item.role === 'user') {
        llmMessages.push({ role: 'user', content: item.content });
      } else if (item.role === 'assistant') {
        llmMessages.push({ role: 'assistant', content: item.content });
      }
    }

    llmMessages.push({ role: 'user', content: userPrompt });

    const maxIterations = this.settings.maxSearchIterations || 6;
    let iteration = 0;
    let finalAnswer = '';

    while (iteration < maxIterations) {
      if (signal?.aborted) throw new Error('Agent execution cancelled by user.');
      iteration++;

      // Step: LLM reasoning turn
      const thoughtStep: AgentStep = {
        id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'thought',
        content: 'Thinking...',
        timestamp: Date.now(),
      };
      steps.push(thoughtStep);
      callbacks?.onStepAdded?.(thoughtStep);

      let stepTokens = '';
      const response = await this.client.chatCompletion(
        llmMessages,
        AGENT_TOOLS,
        {
          onToken: (token) => {
            stepTokens += token;
            callbacks?.onToken?.(token);
          },
        },
        signal
      );

      thoughtStep.content = stepTokens.trim() || 'Processed context';
      callbacks?.onStepUpdated?.(thoughtStep);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // No tool calls: LLM generated final answer
        finalAnswer = response.content;
        break;
      }

      // Append assistant's tool-call message
      llmMessages.push({
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.toolCalls,
      });

      // Execute each tool call
      for (const toolCall of response.toolCalls) {
        if (signal?.aborted) throw new Error('Agent execution cancelled.');

        const name = toolCall.function.name;
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          args = {};
        }

        const toolStep: AgentStep = {
          id: `tool_${toolCall.id}`,
          type: 'tool_call',
          content: `Executing ${name}`,
          toolName: name,
          toolArgs: args,
          timestamp: Date.now(),
        };
        steps.push(toolStep);
        callbacks?.onStepAdded?.(toolStep);

        let toolOutputStr = '';

        try {
          toolOutputStr = await this.executeTool(name, args, currentScope, addCitation, signal);
          toolStep.type = 'tool_result';
          toolStep.toolResult = toolOutputStr;
          callbacks?.onStepUpdated?.(toolStep);
        } catch (err: any) {
          toolOutputStr = `Error executing tool ${name}: ${err.message || String(err)}`;
          toolStep.type = 'error';
          toolStep.content = toolOutputStr;
          callbacks?.onStepUpdated?.(toolStep);
        }

        llmMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name,
          content: toolOutputStr,
        });
      }
    }

    return {
      content: finalAnswer,
      steps,
      citations: Array.from(citationMap.values()),
    };
  }

  /**
   * Executes an individual tool with security boundary enforcement
   */
  private async executeTool(
    name: string,
    args: Record<string, any>,
    currentScope: CurrentScopeContext,
    addCitation: (msg: DiscordMessage, channelName?: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    switch (name) {
      case 'get_current_context': {
        return JSON.stringify(
          {
            currentChannelId: currentScope.channelId,
            currentChannelName: currentScope.channelName,
            channelType: currentScope.channelType,
            isDM: currentScope.isDM,
            isGroupDM: currentScope.isGroupDM,
            isGuild: currentScope.isGuild,
            guildName: currentScope.guildName,
            otherParticipant: currentScope.otherUser
              ? { id: currentScope.otherUser.id, name: currentScope.otherUser.globalName || currentScope.otherUser.username }
              : null,
            mutualGroupDMs: currentScope.mutualGroupDMs?.map((g) => ({ id: g.id, name: g.name })) || [],
          },
          null,
          2
        );
      }

      case 'list_available_channels': {
        if (currentScope.isGuild) {
          return JSON.stringify(
            {
              context: 'Server / Guild Channels',
              guildName: currentScope.guildName,
              channels: currentScope.accessibleGuildChannels || [],
            },
            null,
            2
          );
        }
        if (currentScope.isDM) {
          return JSON.stringify(
            {
              context: 'Direct Message & Mutual Groups',
              currentDM: { id: currentScope.channelId, name: currentScope.channelName },
              mutualGroupDMs: currentScope.mutualGroupDMs || [],
            },
            null,
            2
          );
        }
        return JSON.stringify({ channels: [{ id: currentScope.channelId, name: currentScope.channelName }] });
      }

      case 'search_messages': {
        const isGuildContext = currentScope.isGuild;
        const targetChannelId = args.channel_id;

        // If targetChannelId is explicitly specified, enforce privacy/scope boundary
        if (targetChannelId) {
          if (!isChannelAllowedInScope(targetChannelId, currentScope)) {
            return `Error: Access denied. Channel ${targetChannelId} is outside of the permitted scope for this context.`;
          }
        }

        const res = await searchDiscordMessages({
          query: args.query,
          channelId: targetChannelId || (!isGuildContext ? currentScope.channelId : undefined),
          guildId: isGuildContext ? currentScope.guildId : undefined,
          authorId: args.author_id,
          has: args.has,
        });

        if (!res.messages || res.messages.length === 0) {
          return `No messages found matching search criteria (Query: "${args.query || ''}", Total indexed: ${res.documentsIndexed ?? 'unknown'}).`;
        }

        const formattedResults: string[] = [];
        for (const group of res.messages.slice(0, 10)) {
          const hitMsg = group.find((m) => m.hit) || group[0];
          if (hitMsg) {
            addCitation(hitMsg, currentScope.channelName);
            formattedResults.push(formatMessageForLLM(hitMsg, currentScope.channelName));
          }
        }

        return `Found ${res.totalResults} matching messages. Top results:\n\n${formattedResults.join('\n\n')}`;
      }

      case 'fetch_surrounding_messages': {
        const { channel_id, message_id, limit } = args;
        const targetChannelId = channel_id || currentScope.channelId;

        if (!isChannelAllowedInScope(targetChannelId, currentScope)) {
          return `Error: Access denied. Channel ${targetChannelId} is outside of allowed scope.`;
        }

        const surrounding = await fetchSurroundingMessages(targetChannelId, message_id, limit || 10);
        if (surrounding.length === 0) {
          return `No surrounding messages found around message ID ${message_id}.`;
        }

        surrounding.forEach((m) => addCitation(m, currentScope.channelName));
        const formatted = surrounding.map((m) => formatMessageForLLM(m)).join('\n');
        return `Surrounding context around message ${message_id} (${surrounding.length} messages):\n\n${formatted}`;
      }

      case 'fetch_recent_messages': {
        const targetChannelId = args.channel_id || currentScope.channelId;

        if (!isChannelAllowedInScope(targetChannelId, currentScope)) {
          return `Error: Access denied. Channel ${targetChannelId} is outside of allowed scope.`;
        }

        const recent = await fetchRecentMessages(targetChannelId, args.limit || 20);
        if (recent.length === 0) {
          return `No recent messages found in channel ${targetChannelId}.`;
        }

        recent.forEach((m) => addCitation(m, currentScope.channelName));
        const formatted = recent.map((m) => formatMessageForLLM(m)).join('\n');
        return `Recent messages in channel (${recent.length} messages):\n\n${formatted}`;
      }

      case 'inspect_image': {
        const { image_url, question } = args;
        if (!image_url) return 'Error: image_url is required.';

        if (!this.settings.enableVision) {
          return `Vision analysis is currently disabled in plugin settings. Image URL: ${image_url}`;
        }

        const analysis = await this.client.analyzeImage(image_url, question || 'Describe this image', signal);
        return `Image Analysis Result for ${image_url}:\n${analysis}`;
      }

      default:
        throw new Error(`Unknown tool function name: ${name}`);
    }
  }
}
