/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ToolDefinition } from '../types';

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful Discord AI Assistant embedded directly in the user's Discord client via Vencord.
Your primary role is to answer questions about past messages, conversations, files, images, and activities across Discord channels and DMs.

### Available Capabilities & Tools:
1. \`get_current_context\`: Call this to see where the user is currently located (current channel, DM participant, server name).
2. \`list_available_channels\`: Lists valid channels you can search (mutual group DMs for DMs, or server channels for guilds).
3. \`search_messages\`: Search Discord's server-side index and local channel history for keywords, authors, exact dates, date ranges, or media attachments (has: link, file, image, etc.).
4. \`fetch_surrounding_messages\`: Given a message ID, get the conversational turns before and after it to understand full context.
5. \`fetch_recent_messages\`: Get the latest messages in the current channel.
6. \`inspect_image\`: Inspect an image attachment to analyze its visual content.

### Rules & Guidelines:
- **Date & Historical Queries ("On this day...", "3 years ago...", "in 2023...")**:
  - Check the [Current System Time & Date] provided in the context to compute the exact target date (e.g., if today is August 18, 2026, 3 years ago is 2023-08-18).
  - Use \`search_messages\` with \`date: "YYYY-MM-DD"\` (or \`after_date\` / \`before_date\`).
  - DO NOT return today's recent messages if the user asked for a date in the past! If no messages were sent on that date, accurately state that no messages were found for that date.
- **Search Strategy**: Start by querying relevant keywords, authors, dates, or attachment filters (\`has: 'link'\`, \`has: 'file'\`, \`has: 'image'\`). If you find a relevant message, call \`fetch_surrounding_messages\` on that message ID to get the complete conversation.
- **Accurate Citations**: Whenever referring to a specific message, include a jump link so the user can click directly to it in Discord.
  Format jump links like: \`[Jump to message](discord://message/{channelId}/{messageId})\` or \`[Jump to message](https://discord.com/channels/{guildId or @me}/{channelId}/{messageId})\`.
- **Honesty**: If a message cannot be found after thorough search, explain clearly what search terms, dates, and channels you checked. Never hallucinate fake Discord message IDs or present today's messages as historical ones.
- **Tone**: Be concise, helpful, and direct. Use markdown formatting (bolding, code blocks, bullet points) effectively.
`;

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_context',
      description: 'Retrieves information about the current Discord channel, server, other participants, and allowed scope boundaries.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_available_channels',
      description: 'Lists all channels within the allowed scope (mutual group DMs if in a DM, or all accessible text channels if in a server).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_messages',
      description: 'Searches message history using Discord server-side search index and local channel context. Supports keywords, authors, exact dates, date ranges, attachments, and channel filters.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search keywords or phrase to look for (can be omitted when searching by media type or date).',
          },
          channel_id: {
            type: 'string',
            description: 'Optional specific channel ID to search in (must be within allowed scope, defaults to current channel).',
          },
          author_id: {
            type: 'string',
            description: 'Optional author Discord user ID to filter by.',
          },
          date: {
            type: 'string',
            description: 'Search messages on a specific date in YYYY-MM-DD format (e.g. "2023-08-18" for 3 years ago on this day).',
          },
          after_date: {
            type: 'string',
            description: 'Search messages sent after this date (YYYY-MM-DD or ISO timestamp).',
          },
          before_date: {
            type: 'string',
            description: 'Search messages sent before this date (YYYY-MM-DD or ISO timestamp).',
          },
          has: {
            type: 'string',
            enum: ['image', 'sound', 'video', 'file', 'link', 'embed', 'sticker'],
            description: 'Filter for messages containing a specific attachment or media type (e.g. link, file, image).',
          },
          sort_by: {
            type: 'string',
            enum: ['timestamp', 'relevance'],
            description: 'Sort search results by timestamp or relevance (default: timestamp).',
          },
          sort_order: {
            type: 'string',
            enum: ['desc', 'asc'],
            description: 'Order of results: "desc" (newest first) or "asc" (oldest first).',
          },
          offset: {
            type: 'number',
            description: 'Page offset for retrieving more results (e.g. 0, 25, 50).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_surrounding_messages',
      description: 'Retrieves the conversational messages before and after a specific message ID to provide context.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel ID containing the target message.',
          },
          message_id: {
            type: 'string',
            description: 'The ID of the target message to fetch surrounding context around.',
          },
          limit: {
            type: 'number',
            description: 'Number of surrounding messages to fetch (default: 10, max: 25).',
          },
        },
        required: ['channel_id', 'message_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_recent_messages',
      description: 'Fetches the most recent messages in a channel.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel ID to fetch recent messages from.',
          },
          limit: {
            type: 'number',
            description: 'Number of recent messages to fetch (default: 20, max: 50).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_image',
      description: 'Inspects an image attachment from a message to analyze its visual content or read text inside it.',
      parameters: {
        type: 'object',
        properties: {
          image_url: {
            type: 'string',
            description: 'The URL of the image attachment to inspect.',
          },
          question: {
            type: 'string',
            description: 'Specific question or detail to look for in the image.',
          },
        },
        required: ['image_url'],
      },
    },
  },
];
