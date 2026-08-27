/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  extractPatternMatches,
  fetchRecentMessages,
  fetchSurroundingMessages,
  filterMessagesLocally,
  formatMessageForLLM,
  formatMessageWithPattern,
} from '../discord/messages';
import { getCurrentScopeContext, isChannelAllowedInScope } from '../discord/scope';
import {
  detectPatternFromQuery,
  RelaxedSearchResult,
  searchDiscordMessagesWithRelaxation,
} from '../discord/search';
import { getChannel, getCurrentUser, resolvePromptMentions } from '../discord/stores';
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

    // Build LLM message sequence with live date/time context
    const now = new Date();
    const nowIso = now.toISOString();
    const nowDateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const nowTimeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

    // Resolve current logged-in user identity
    const currentUser = currentScope.currentUser || getCurrentUser();
    let userContext = '';
    if (currentUser) {
      const displayName = currentUser.globalName ? `${currentUser.globalName} (@${currentUser.username})` : `@${currentUser.username}`;
      userContext = `\n[Current Logged-in User (You/Me)]: ${displayName} (Discord User ID: "${currentUser.id}")\n*Guidance: When the user asks about messages they sent (e.g. "where I talk about...", "my message", "what did I say"), set author_id: "${currentUser.id}".*`;
    }

    // Resolve scope details
    let scopeDetails = '';
    if (currentScope.isGuild) {
      const accessibleCount = currentScope.accessibleGuildChannels?.length ?? 1;
      scopeDetails = `\n[Active Scope Context]: Server: "${currentScope.guildName || 'Server'}" (Guild ID: "${currentScope.guildId}"), Active Channel: #${currentScope.channelName} (${currentScope.channelId}), Total Accessible Server Channels: ${accessibleCount}\n*Guidance: In servers, you can search across ALL accessible channels by omitting channel_id or setting guild_wide: true.*`;
    } else if (currentScope.isDM) {
      const other = currentScope.otherUser;
      const partnerName = other?.globalName ? `${other.globalName} (@${other.username})` : other ? `@${other.username}` : 'User';
      const gdmCount = currentScope.mutualGroupDMs?.length ?? 0;
      const gdmText = gdmCount > 0 ? ` (with ${gdmCount} mutual group chat(s))` : '';
      scopeDetails = `\n[Active Scope Context]: Direct Message with ${partnerName} (ID: "${other?.id || ''}")${gdmText}, Channel: #${currentScope.channelName} (${currentScope.channelId})`;
    } else if (currentScope.isGroupDM) {
      scopeDetails = `\n[Active Scope Context]: Group DM: #${currentScope.channelName} (${currentScope.channelId})`;
    } else {
      scopeDetails = `\n[Active Scope Context]: Channel: #${currentScope.channelName} (${currentScope.channelId})`;
    }

    // Resolve any mentioned users in the user's prompt
    const mentionedUsers = resolvePromptMentions(userPrompt, currentScope.channelId, currentScope.guildId);
    let mentionContext = '';
    if (mentionedUsers.length > 0) {
      const userList = mentionedUsers.map((u) => {
        const name = u.globalName ? `${u.globalName} (@${u.username})` : `@${u.username}`;
        return `- ${name} (Discord ID: "${u.id}")${u.bot ? ' [Bot]' : ''}`;
      });
      mentionContext = `\n\n[Mentioned User(s) in Prompt Context]:\n${userList.join('\n')}\n*Guidance: The user explicitly mentioned the person/people above. When searching for messages sent by them or discussing them, use their exact author_id (e.g. author_id: "${mentionedUsers[0].id}") or query their username/ID.*`;
    }

    const systemPrompt = this.settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    const llmMessages: LLMMessage[] = [
      {
        role: 'system',
        content: `${systemPrompt}\n\n[Current System Time & Date]: ${nowDateStr}, ${nowTimeStr} (${nowIso})${userContext}${scopeDetails}${mentionContext}`,
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
        const loggedIn = currentScope.currentUser || getCurrentUser();
        return JSON.stringify(
          {
            currentChannelId: currentScope.channelId,
            currentChannelName: currentScope.channelName,
            channelType: currentScope.channelType,
            isDM: currentScope.isDM,
            isGroupDM: currentScope.isGroupDM,
            isGuild: currentScope.isGuild,
            guildName: currentScope.guildName,
            guildId: currentScope.guildId,
            currentUser: loggedIn
              ? { id: loggedIn.id, username: loggedIn.username, globalName: loggedIn.globalName || null }
              : null,
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
        const guildWide = Boolean(args.guild_wide || args.channel_id === 'all');
        const targetChannelId = guildWide
          ? undefined
          : (args.channel_id || (!isGuildContext ? currentScope.channelId : undefined));

        // If targetChannelId is specified, enforce privacy/scope boundary
        if (targetChannelId && !isChannelAllowedInScope(targetChannelId, currentScope)) {
          return `Error: Access denied. Channel ${targetChannelId} is outside of the permitted scope for this context.`;
        }

        const targetChannel = targetChannelId ? getChannel(targetChannelId) : null;
        const resolvedGuildId = targetChannel?.guild_id || (isGuildContext ? currentScope.guildId : undefined);

        const duringDate = args.date || args.during_date;
        const afterDate = args.after_date;
        const beforeDate = args.before_date;
        const scanLimit = Math.min(Math.max(Number(args.limit) || 50, 10), 100);

        let rawQuery = args.query?.trim();
        let effectivePattern = args.pattern?.trim();
        let patternDescription: string | null = null;

        // Auto-detect pattern from query if pattern wasn't explicitly passed
        if (rawQuery) {
          const detected = detectPatternFromQuery(rawQuery);
          if (detected.pattern && !effectivePattern) {
            effectivePattern = detected.pattern;
            patternDescription = detected.patternDescription;
            rawQuery = detected.cleanedQuery || undefined;
          }
        }

        const formatGroup = (msgs: DiscordMessage[], defaultChannelName: string) => {
          const allExtracted: string[] = [];
          const lines = msgs.map((m) => {
            const ch = getChannel(m.channel_id);
            const chName = ch?.name || defaultChannelName;
            addCitation(m, chName);
            const { formatted, matchedValues } = formatMessageWithPattern(m, chName, effectivePattern);
            if (matchedValues.length > 0) allExtracted.push(...matchedValues);
            return formatted;
          });
          const unique = Array.from(new Set(allExtracted));
          const summary = unique.length > 0
            ? `\n• Extracted Value(s): ${unique.map((v) => `"${v}"`).join(', ')}\n`
            : '';
          return { lines, summary };
        };

        let res: RelaxedSearchResult | null = null;
        let searchError: string | null = null;

        // If we have a query, authorId, has, or date criteria, attempt Discord Search Index
        if (rawQuery || args.author_id || args.has || duringDate || afterDate || beforeDate) {
          try {
            res = await searchDiscordMessagesWithRelaxation({
              query: rawQuery,
              pattern: effectivePattern,
              channelId: targetChannelId,
              guildId: resolvedGuildId,
              guildWide: guildWide || (!targetChannelId && isGuildContext),
              authorId: args.author_id,
              has: args.has,
              duringDate,
              afterDate,
              beforeDate,
              sortBy: args.sort_by,
              sortOrder: args.sort_order,
              offset: args.offset,
              pinned: args.pinned,
              mentions: args.mentions,
            });
          } catch (err: any) {
            searchError = err?.message || String(err);
          }
        }

        // Check if server search returned positive results
        if (res && res.messages && res.messages.length > 0) {
          let hitMessages: DiscordMessage[] = [];
          for (const group of res.messages.slice(0, 25)) {
            const hitMsg = Array.isArray(group) ? (group.find((m) => m.hit) || group[0]) : group;
            if (hitMsg) hitMessages.push(hitMsg);
          }

          if (effectivePattern) {
            hitMessages = filterMessagesLocally(hitMessages, {
              pattern: effectivePattern,
              authorId: args.author_id,
              duringDate,
              afterDate,
              beforeDate,
            });
          }

          if (hitMessages.length > 0) {
            const { lines, summary } = formatGroup(hitMessages.slice(0, 15), currentScope.channelName);
            const relaxedNotice = res.relaxedQueryUsed
              ? ` (Note: exact query "${res.originalQuery}" returned 0 results, automatically broadened to keyword "${res.relaxedQueryUsed}")`
              : '';
            const scopeNote = guildWide || (!targetChannelId && isGuildContext)
              ? `Server-wide: ${currentScope.guildName || 'Server'}`
              : `#${targetChannel?.name || currentScope.channelName}`;

            return `Found ${hitMessages.length} matching messages (Discord Search Index [${scopeNote}])${relaxedNotice}:${summary}\n\n${lines.join('\n\n')}`;
          }
        }

        // Automatic Local / Channel History Scan Fallback:
        const localScanChannelId = targetChannelId || currentScope.channelId;
        if (localScanChannelId) {
          const recent = await fetchRecentMessages(localScanChannelId, scanLimit);
          if (recent.length > 0) {
            const matchedLocal = filterMessagesLocally(recent, {
              query: rawQuery,
              pattern: effectivePattern,
              has: args.has,
              authorId: args.author_id,
              duringDate,
              afterDate,
              beforeDate,
            });

            if (matchedLocal.length > 0) {
              const { lines, summary } = formatGroup(matchedLocal.slice(-15), targetChannel?.name || currentScope.channelName);
              const patLabel = patternDescription || (effectivePattern ? `Pattern: ${effectivePattern}` : '');
              const patNote = patLabel ? ` [${patLabel}]` : '';

              return `Found ${matchedLocal.length} matching messages in channel history (#${targetChannel?.name || currentScope.channelName})${patNote}:${summary}\n\n${lines.join('\n\n')}`;
            }
          }
        }

        // If in DM and 0 hits found in current DM, check mutual group DMs automatically
        if (currentScope.isDM && currentScope.mutualGroupDMs && currentScope.mutualGroupDMs.length > 0 && !args.channel_id) {
          const gdmResults: string[] = [];
          for (const gdm of currentScope.mutualGroupDMs.slice(0, 3)) {
            const recentGDM = await fetchRecentMessages(gdm.id, 40);
            const matchedGDM = filterMessagesLocally(recentGDM, {
              query: rawQuery,
              pattern: effectivePattern,
              has: args.has,
              authorId: args.author_id,
              duringDate,
              afterDate,
              beforeDate,
            });
            if (matchedGDM.length > 0) {
              const { lines } = formatGroup(matchedGDM, gdm.name);
              gdmResults.push(...lines);
            }
          }
          if (gdmResults.length > 0) {
            return `Found ${gdmResults.length} matching messages in mutual group chat(s):\n\n${gdmResults.join('\n\n')}`;
          }
        }

        const criteriaDetails: string[] = [];
        if (rawQuery) criteriaDetails.push(`Query: "${rawQuery}"`);
        if (effectivePattern) criteriaDetails.push(`Pattern: ${effectivePattern}${patternDescription ? ` (${patternDescription})` : ''}`);
        if (args.has) criteriaDetails.push(`Has: "${args.has}"`);
        if (duringDate) criteriaDetails.push(`Date: ${duringDate}`);
        if (afterDate) criteriaDetails.push(`After: ${afterDate}`);
        if (beforeDate) criteriaDetails.push(`Before: ${beforeDate}`);
        if (args.author_id) criteriaDetails.push(`Author ID: ${args.author_id}`);

        const searchedLocation = guildWide || (!targetChannelId && isGuildContext)
          ? `server "${currentScope.guildName || 'Server'}"`
          : `channel #${targetChannel?.name || currentScope.channelName}`;

        if (searchError) {
          return `Search query failed: ${searchError}. No matching messages found for ${criteriaDetails.join(', ') || 'criteria'} in ${searchedLocation}. Suggested next steps: try broader anchor keywords (1-2 distinctive words), regex patterns, or search server-wide.`;
        }

        return `No messages found matching search criteria (${criteriaDetails.join(', ') || 'unspecified criteria'}) in ${searchedLocation}. Suggested next steps: try searching with 1 distinctive anchor keyword, a regex pattern, removing date/author restrictions, or searching server-wide.`;
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

        const fetchLimit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
        const rawMessages = await fetchRecentMessages(targetChannelId, fetchLimit);
        if (rawMessages.length === 0) {
          return `No recent messages found in channel ${targetChannelId}.`;
        }

        let pattern = args.pattern?.trim();
        let patternDescription: string | null = null;
        if (pattern) {
          const patInfo = detectPatternFromQuery(pattern);
          if (patInfo.pattern) {
            pattern = patInfo.pattern;
            patternDescription = patInfo.patternDescription;
          }
        }

        let finalMessages = rawMessages;
        if (pattern) {
          finalMessages = filterMessagesLocally(rawMessages, { pattern });
          if (finalMessages.length === 0) {
            return `No messages matching pattern "${pattern}" found in the last ${rawMessages.length} messages of channel #${currentScope.channelName}.`;
          }
        }

        const allExtracted: string[] = [];
        const formatted = finalMessages.map((m) => {
          addCitation(m, currentScope.channelName);
          const { formatted: msgStr, matchedValues } = formatMessageWithPattern(m, currentScope.channelName, pattern);
          if (matchedValues.length > 0) allExtracted.push(...matchedValues);
          return msgStr;
        }).join('\n\n');

        const uniqueExtracted = Array.from(new Set(allExtracted));
        const patternSummary = uniqueExtracted.length > 0
          ? `\n• Extracted Value(s): ${uniqueExtracted.map((v) => `"${v}"`).join(', ')}\n`
          : '';
        const patLabel = patternDescription || (pattern ? `Pattern: ${pattern}` : '');
        const patNote = patLabel ? ` [${patLabel}]` : '';

        return `Recent messages in channel (${finalMessages.length} messages)${patNote}:${patternSummary}\n\n${formatted}`;
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
