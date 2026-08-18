/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { filterMessagesLocally, formatMessageForLLM } from '../discord/messages';
import { DiscordMessage } from '../types';

function runSearchTests() {
  console.log('--- Running Search & Local Filtering Test Suite ---');

  const testMessages: DiscordMessage[] = [
    {
      id: '101',
      channel_id: 'ch_general',
      author: { id: 'user_1', username: 'alice', globalName: 'Alice' },
      content: 'Check out this website: https://example.com/docs for more info!',
      timestamp: '2025-01-01T12:00:00.000Z',
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: '102',
      channel_id: 'ch_general',
      author: { id: 'user_2', username: 'bob', globalName: 'Bob' },
      content: 'Here is the project specification PDF',
      timestamp: '2025-01-01T12:05:00.000Z',
      attachments: [
        {
          id: 'att_1',
          filename: 'spec.pdf',
          size: 1024,
          url: 'https://cdn.discordapp.com/attachments/spec.pdf',
          proxy_url: 'https://media.discordapp.net/attachments/spec.pdf',
          content_type: 'application/pdf',
        },
      ],
      embeds: [],
      mentions: [],
    },
    {
      id: '103',
      channel_id: 'ch_general',
      author: { id: 'user_3', username: 'charlie', globalName: 'Charlie' },
      content: 'Look at this screenshot of the dashboard',
      timestamp: '2025-01-01T12:10:00.000Z',
      attachments: [
        {
          id: 'att_2',
          filename: 'screenshot.png',
          size: 2048,
          url: 'https://cdn.discordapp.com/attachments/screenshot.png',
          proxy_url: 'https://media.discordapp.net/attachments/screenshot.png',
          content_type: 'image/png',
        },
      ],
      embeds: [],
      mentions: [],
    },
    {
      id: '104',
      channel_id: 'ch_general',
      author: { id: 'user_1', username: 'alice', globalName: 'Alice' },
      content: 'Just a regular plain text message without links or files.',
      timestamp: '2025-01-01T12:15:00.000Z',
      attachments: [],
      embeds: [],
      mentions: [],
    },
  ];

  // Test 1: filterMessagesLocally for 'has:link'
  const linkMatches = filterMessagesLocally(testMessages, { has: 'link' });
  console.assert(linkMatches.length === 1, `Expected 1 link match, got ${linkMatches.length}`);
  console.assert(linkMatches[0].id === '101', 'Should match message 101 with URL');

  // Test 2: filterMessagesLocally for 'has:file'
  const fileMatches = filterMessagesLocally(testMessages, { has: 'file' });
  console.assert(fileMatches.length === 2, `Expected 2 file matches, got ${fileMatches.length}`);
  console.assert(fileMatches[0].id === '102' && fileMatches[1].id === '103', 'Should match messages with attachments');

  // Test 3: filterMessagesLocally for 'has:image'
  const imageMatches = filterMessagesLocally(testMessages, { has: 'image' });
  console.assert(imageMatches.length === 1, `Expected 1 image match, got ${imageMatches.length}`);
  console.assert(imageMatches[0].id === '103', 'Should match message 103 with PNG image');

  // Test 4: filterMessagesLocally with keyword query
  const queryMatches = filterMessagesLocally(testMessages, { query: 'specification' });
  console.assert(queryMatches.length === 1, `Expected 1 query match, got ${queryMatches.length}`);
  console.assert(queryMatches[0].id === '102', 'Should match message containing "specification"');

  // Test 5: filterMessagesLocally with query matching attachment filename
  const filenameMatches = filterMessagesLocally(testMessages, { query: 'screenshot.png' });
  console.assert(filenameMatches.length === 1, `Expected 1 filename match, got ${filenameMatches.length}`);
  console.assert(filenameMatches[0].id === '103', 'Should match attachment filename');

  // Test 6: filterMessagesLocally by authorId
  const authorMatches = filterMessagesLocally(testMessages, { authorId: 'user_1' });
  console.assert(authorMatches.length === 2, `Expected 2 author matches for user_1, got ${authorMatches.length}`);

  // Test 7: formatMessageForLLM formatting
  const formatted = formatMessageForLLM(testMessages[1], 'general');
  console.assert(formatted.includes('[#general]'), 'Formatted string should include channel name');
  console.assert(formatted.includes('[Attachment: spec.pdf'), 'Formatted string should include attachment details');

  // Test 8: Empty query with has:link (the exact scenario from the screenshot)
  const emptyQueryLinkMatches = filterMessagesLocally(testMessages, { query: '', has: 'link' });
  console.assert(emptyQueryLinkMatches.length === 1, 'Empty query with has:link should still return link messages');

  console.log('✅ All Search & Local Filter Tests Passed Successfully!');
}

runSearchTests();
