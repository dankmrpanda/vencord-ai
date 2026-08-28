/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  extractPatternMatches,
  filterMessagesLocally,
} from '../discord/messages';
import {
  dateToSnowflake,
  buildSearchCacheKey,
  detectPatternFromQuery,
  extractAnchorKeywords,
  generateRelaxedQueries,
  resolveDateSnowflakeBounds,
  snowflakeToDate,
} from '../discord/search';
import { resolvePromptMentions } from '../discord/stores';
import { DiscordMessage } from '../types';
import { assert } from './assert';

function runSearchTests() {
  console.log('--- Running Search & Local Filtering Test Suite ---');

  const channelKey = buildSearchCacheKey({ guildId: 'g', channelId: 'c', guildWide: false, query: 'same' });
  const guildKey = buildSearchCacheKey({ guildId: 'g', channelId: 'c', guildWide: true, query: 'same' });
  assert(channelKey !== guildKey, 'Channel-only and guild-wide cache entries must never collide');

  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const dstBounds = resolveDateSnowflakeBounds({ duringDate: '2026-03-08' });
  const dstStart = snowflakeToDate(dstBounds.minId!);
  const dstEnd = snowflakeToDate(dstBounds.maxId!);
  assert(dstEnd.getTime() - dstStart.getTime() === 23 * 60 * 60 * 1000 - 1, 'Spring DST local date must span the full 23-hour local day');
  process.env.TZ = previousTimezone;

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
  assert(linkMatches.length === 1, `Expected 1 link match, got ${linkMatches.length}`);
  assert(linkMatches[0].id === '101', 'Should match message 101 with URL');

  // Test 2: filterMessagesLocally for 'has:file'
  const fileMatches = filterMessagesLocally(testMessages, { has: 'file' });
  assert(fileMatches.length === 2, `Expected 2 file matches, got ${fileMatches.length}`);
  assert(fileMatches.some((m) => m.id === '102') && fileMatches.some((m) => m.id === '103'), 'Should match messages with attachments');

  // Test 3: filterMessagesLocally for 'has:image'
  const imageMatches = filterMessagesLocally(testMessages, { has: 'image' });
  assert(imageMatches.length === 1, `Expected 1 image match, got ${imageMatches.length}`);
  assert(imageMatches[0].id === '103', 'Should match message 103 with PNG image');

  // Test 4: filterMessagesLocally with keyword query
  const queryMatches = filterMessagesLocally(testMessages, { query: 'specification' });
  assert(queryMatches.length === 1, `Expected 1 query match, got ${queryMatches.length}`);
  assert(queryMatches[0].id === '102', 'Should match message containing "specification"');

  // Test 5: filterMessagesLocally with query matching attachment filename
  const filenameMatches = filterMessagesLocally(testMessages, { query: 'screenshot.png' });
  assert(filenameMatches.length === 1, `Expected 1 filename match, got ${filenameMatches.length}`);
  assert(filenameMatches[0].id === '103', 'Should match attachment filename');

  // Test 6: filterMessagesLocally by authorId
  const authorMatches = filterMessagesLocally(testMessages, { authorId: 'user_1' });
  assert(authorMatches.length === 2, `Expected 2 author matches for user_1, got ${authorMatches.length}`);

  // Test 8: Empty query with has:link (the exact scenario from the screenshot)
  const emptyQueryLinkMatches = filterMessagesLocally(testMessages, { query: '', has: 'link' });
  assert(emptyQueryLinkMatches.length === 1, 'Empty query with has:link should still return link messages');

  // Test 9: Discord jump URL matching
  const testUrls = [
    'https://discord.com/channels/123/456/789',
    'https://ptb.discordapp.com/channels/@me/456/789',
    'discord://message/456/789',
    'discord://channels/123/456/789',
    '/channels/123/456/789',
  ];

  // Test 10: Snowflake conversion functions
  const sampleTime = new Date('2023-08-18T12:00:00.000Z').getTime();
  const snowflake = dateToSnowflake(sampleTime);
  const recoveredDate = snowflakeToDate(snowflake);
  assert(Math.abs(recoveredDate.getTime() - sampleTime) < 10, 'Snowflake conversion should preserve timestamp accuracy');

  // Test 11: filterMessagesLocally with duringDate
  const dateMatch = filterMessagesLocally(testMessages, { duringDate: '2025-01-01' });
  assert(dateMatch.length === 4, `Expected all 4 messages on 2025-01-01, got ${dateMatch.length}`);

  // Test 13: Exact scenario from user request: token matching and number range handling
  const flightMessages: DiscordMessage[] = [
    {
      id: '201',
      channel_id: 'ch_travel',
      author: { id: 'user_raymond', username: 'raymond', globalName: 'Raymond' },
      content: 'My United flight connection in Denver was only 3-5 minutes, barely made it to gate B24!',
      timestamp: '2025-06-15T14:30:00.000Z',
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: '202',
      channel_id: 'ch_travel',
      author: { id: 'user_raymond', username: 'raymond', globalName: 'Raymond' },
      content: 'Flying Delta next week, connection is 45 minutes in Atlanta.',
      timestamp: '2025-06-16T10:00:00.000Z',
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: '203',
      channel_id: 'ch_travel',
      author: { id: 'user_friend', username: 'alex', globalName: 'Alex' },
      content: 'United connection was delayed by 3 hours unfortunately.',
      timestamp: '2025-06-17T09:00:00.000Z',
      attachments: [],
      embeds: [],
      mentions: [],
    },
  ];

  // Test 13a: filterMessagesLocally with multi-word query (tokenized match and top ranking)
  const multiTokenMatches = filterMessagesLocally(flightMessages, {
    query: 'united connection 3-5 minutes',
  });
  assert(multiTokenMatches.length >= 1, `Expected at least 1 match for united connection 3-5 minutes, got ${multiTokenMatches.length}`);
  assert(multiTokenMatches[0].id === '201', 'Should rank message 201 highest with 100% token match');

  // Test 13b: filterMessagesLocally with authorId and anchor keyword
  const authorUnitedMatches = filterMessagesLocally(flightMessages, {
    query: 'united',
    authorId: 'user_raymond',
  });
  assert(authorUnitedMatches.length === 1, `Expected 1 match for author raymond + united, got ${authorUnitedMatches.length}`);
  assert(authorUnitedMatches[0].id === '201', 'Should match raymond message 201');

  // Test 14: Anchor keyword extraction
  const keywords = extractAnchorKeywords('find the message where i talk about my united connection being around 3-5 minutes only');
  assert(keywords.includes('united'), 'Keywords should include "united"');
  assert(keywords.includes('connection'), 'Keywords should include "connection"');
  assert(!keywords.includes('where'), 'Keywords should not include stopword "where"');
  assert(!keywords.includes('about'), 'Keywords should not include stopword "about"');

  // Test 15: Query relaxation generator
  const relaxed = generateRelaxedQueries('united connection 3-5 minutes');
  assert(relaxed.length > 0, 'Should generate relaxed queries');
  assert(relaxed.includes('united connection') || relaxed.includes('united'), 'Should include simplified anchor queries');

  // --- NEW TESTS: Pattern Detection, Extraction & Smart Search Handling ---

  // Test 16a: detectPatternFromQuery for "6-digit"
  const pat6 = detectPatternFromQuery('6-digit');
  assert(pat6.pattern === '\\b\\d{6}\\b', `Expected \\b\\d{6}\\b, got ${pat6.pattern}`);
  assert(pat6.cleanedQuery === '', `Expected empty cleanedQuery, got "${pat6.cleanedQuery}"`);

  // Test 16b: detectPatternFromQuery for "find me all the 6 digit numbers in this dm"
  const patUserPrompt = detectPatternFromQuery('find me all the 6 digit numbers in this dm');
  assert(patUserPrompt.pattern === '\\b\\d{6}\\b', `Expected \\b\\d{6}\\b for user prompt, got ${patUserPrompt.pattern}`);
  assert(patUserPrompt.cleanedQuery === '', `Expected empty cleanedQuery for user prompt, got "${patUserPrompt.cleanedQuery}"`);

  // Test 16c: detectPatternFromQuery for "invoice 6-digit"
  const patInvoice = detectPatternFromQuery('invoice 6-digit');
  assert(patInvoice.pattern === '\\b\\d{6}\\b', `Expected \\b\\d{6}\\b for invoice 6-digit, got ${patInvoice.pattern}`);
  assert(patInvoice.cleanedQuery === 'invoice', `Expected cleanedQuery "invoice", got "${patInvoice.cleanedQuery}"`);

  // Test 16d: detectPatternFromQuery for "4-digit pin"
  const patPin = detectPatternFromQuery('4-digit pin');
  assert(patPin.pattern === '\\b\\d{4}\\b', `Expected \\b\\d{4}\\b, got ${patPin.pattern}`);

  // Test 16e: detectPatternFromQuery for "phone numbers"
  const patPhone = detectPatternFromQuery('phone numbers');
  assert(patPhone.pattern !== null && patPhone.pattern.includes('\\d{4}'), 'Should detect phone pattern');

  // Test 16f: detectPatternFromQuery for "emails"
  const patEmail = detectPatternFromQuery('emails');
  assert(patEmail.pattern !== null && patEmail.pattern.includes('@'), 'Should detect email pattern');

  // Test 16g: detectPatternFromQuery for explicit regex "\b\d{6}\b"
  const patRegex = detectPatternFromQuery('\\b\\d{6}\\b');
  assert(patRegex.pattern === '\\b\\d{6}\\b', `Expected explicit regex pattern preserved, got ${patRegex.pattern}`);

  // Test 16h: detectPatternFromQuery for regular non-pattern query "united flight"
  const patNormal = detectPatternFromQuery('united flight');
  assert(patNormal.pattern === null, 'Normal query should not produce a pattern');
  assert(patNormal.cleanedQuery === 'united flight', `Expected "united flight", got "${patNormal.cleanedQuery}"`);

  // Test 17: DM Messages matching 6-digit numbers (The exact scenario from user's screenshot)
  const dmMessages: DiscordMessage[] = [
    {
      id: '301',
      channel_id: 'dm_panda',
      author: { id: 'user_panda', username: 'mr.panda', globalName: 'Mr Panda' },
      content: 'Here is your 2FA verification code: 582910',
      timestamp: '2025-08-20T10:00:00.000Z',
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: '302',
      channel_id: 'dm_panda',
      author: { id: 'user_panda', username: 'mr.panda', globalName: 'Mr Panda' },
      content: 'Hey, did you get my message about lunch at 12:30?',
      timestamp: '2025-08-20T10:05:00.000Z',
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: '303',
      channel_id: 'dm_panda',
      author: { id: 'user_me', username: 'raymond', globalName: 'Raymond' },
      content: 'Also backup code is 491024 if needed, meeting ID 892301.',
      timestamp: '2025-08-20T10:10:00.000Z',
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: '304',
      channel_id: 'dm_panda',
      author: { id: 'user_panda', username: 'mr.panda', globalName: 'Mr Panda' },
      content: 'Just 123 test numbers without six digits.',
      timestamp: '2025-08-20T10:15:00.000Z',
      attachments: [],
      embeds: [],
      mentions: [],
    },
  ];

  // Test 17a: filterMessagesLocally with pattern "\b\d{6}\b"
  const matched6DigitMsgs = filterMessagesLocally(dmMessages, { pattern: '\\b\\d{6}\\b' });
  assert(matched6DigitMsgs.length === 2, `Expected 2 messages with 6-digit numbers, got ${matched6DigitMsgs.length}`);
  assert(matched6DigitMsgs.some((m) => m.id === '301'), 'Should match message 301');
  assert(matched6DigitMsgs.some((m) => m.id === '303'), 'Should match message 303');
  assert(!matched6DigitMsgs.some((m) => m.id === '302' || m.id === '304'), 'Should NOT match messages 302 or 304');

  // Test 18: extractPatternMatches
  const msg301Values = extractPatternMatches(dmMessages[0].content, '\\b\\d{6}\\b');
  assert(msg301Values.length === 1 && msg301Values[0] === '582910', `Expected ["582910"], got ${JSON.stringify(msg301Values)}`);

  const msg303Values = extractPatternMatches(dmMessages[2].content, '\\b\\d{6}\\b');
  assert(
    msg303Values.length === 2 && msg303Values.includes('491024') && msg303Values.includes('892301'),
    `Expected ["491024", "892301"], got ${JSON.stringify(msg303Values)}`
  );

  // Test 19: Relaxation on pattern query "6-digit" produces []
  const relaxedPattern = generateRelaxedQueries('6-digit');
  assert(relaxedPattern.length === 0, `Relaxed queries for pattern "6-digit" should be empty, got ${JSON.stringify(relaxedPattern)}`);

  // Test 20: Range and quantifier pattern detection
  const patRange = detectPatternFromQuery('4 to 8 digits');
  assert(patRange.pattern === '\\b\\d{4,8}\\b', `Expected \\b\\d{4,8}\\b, got ${patRange.pattern}`);

  const patMin = detectPatternFromQuery('at least 5 digits');
  assert(patMin.pattern === '\\b\\d{5,}\\b', `Expected \\b\\d{5,}\\b, got ${patMin.pattern}`);

  const patMax = detectPatternFromQuery('up to 6 digits');
  assert(patMax.pattern === '\\b\\d{1,6}\\b', `Expected \\b\\d{1,6}\\b, got ${patMax.pattern}`);

  // Test 21: Hex code and IP address patterns
  const patHex = detectPatternFromQuery('hex colors');
  assert(patHex.pattern !== null && patHex.pattern.includes('#[0-9a-fA-F]'), 'Should detect hex pattern');

  const patIP = detectPatternFromQuery('ip address');
  assert(patIP.pattern !== null && patIP.pattern.includes('\\d{1,3}\\.'), 'Should detect IP pattern');

  // Test 22: Message with embeds and attachments pattern matching
  const complexMessage: DiscordMessage = {
    id: '401',
    channel_id: 'ch_dev',
    author: { id: 'user_bot', username: 'authbot', globalName: 'Auth Bot' },
    content: 'Security Alert: New login detected.',
    timestamp: '2025-08-20T12:00:00.000Z',
    attachments: [],
    embeds: [
      {
        title: 'Authentication Request',
        description: 'Use verification pin 739102 to authorize login from 192.168.1.100',
      },
    ],
    mentions: [],
  };

  const complexMatches = filterMessagesLocally([complexMessage], { pattern: '\\b\\d{6}\\b' });
  assert(complexMatches.length === 1, 'Should match 6-digit number inside embed description');
  const embedExtracted = extractPatternMatches(
    `${complexMessage.content} ${complexMessage.embeds[0].title} ${complexMessage.embeds[0].description}`,
    '\\b\\d{6}\\b'
  );
  assert(embedExtracted.includes('739102'), `Expected 739102 in embedExtracted, got ${JSON.stringify(embedExtracted)}`);

  console.log('✅ All Search & Local Filter Tests Passed Successfully!');
}

runSearchTests();
