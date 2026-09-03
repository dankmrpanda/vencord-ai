/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelType, CurrentScopeContext, DiscordAttachment, DiscordEmbed, DiscordMessage, DiscordUser } from '../types';
import { assert } from './assert';

// ============================================================================
// 1. DETERMINISTIC PSEUDO-RANDOM NUMBER GENERATOR (Mulberry32)
// ============================================================================

export function createPRNG(seed: number = 421098) {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// 2. REALISTIC DISCORD TOPOLOGY & VOCABULARY DEFINITIONS
// ============================================================================

export interface BenchmarkTopology {
  guilds: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; name: string; guildId?: string; type: ChannelType; topic?: string }>;
  dms: Array<{ id: string; name: string; recipients: string[]; isGroupDM: boolean }>;
  users: DiscordUser[];
}

export const GUILD_NAMES = [
  'Engineering HQ',
  'Product & Design',
  'Gaming Lounge',
  'Open Source Devs',
  'DevOps & Infra',
  'AI Research Lab',
  'Community Hub',
  'Crypto & Web3',
  'Security Red Team',
  'Off-Topic Lounge',
];

export const VOCABULARY_COMMON = [
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on', 'with',
  'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if',
  'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him',
  'know', 'take', 'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than',
  'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two',
  'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because', 'any', 'these', 'give',
  'day', 'most', 'us', 'great', 'check', 'sure', 'thanks', 'need', 'fixed', 'broken', 'trying', 'push',
  'pull', 'found', 'tested', 'working', 'help', 'looks', 'awesome', 'sounds', 'today', 'tomorrow', 'yesterday',
];

export const VOCABULARY_TECHNICAL = [
  'database', 'postgres', 'postgresql', 'sqlite', 'indexeddb', 'redis', 'mysql', 'elasticsearch',
  'latency', 'throughput', 'p50', 'p95', 'p99', 'benchmark', 'optimizer', 'profiler', 'memory',
  'docker', 'container', 'kubernetes', 'k8s', 'cluster', 'node', 'pod', 'deployment', 'ingress',
  'migration', 'schema', 'table', 'column', 'foreign', 'primary', 'index', 'lock', 'deadlock', 'transaction',
  'typescript', 'javascript', 'react', 'zustand', 'redux', 'saga', 'hook', 'component', 'props', 'state',
  'webpack', 'vite', 'rollup', 'esbuild', 'tsconfig', 'bundle', 'treeshaking', 'polyfill',
  'endpoint', 'rest', 'graphql', 'grpc', 'websocket', 'http', 'https', 'header', 'payload', 'status',
  'token', 'jwt', 'auth', 'oauth', 'session', 'cookie', 'permission', 'role', 'scopes', 'credential',
  'cache', 'memcached', 'eviction', 'ttl', 'lru', 'invalidation', 'flush', 'hit', 'miss',
  'async', 'await', 'promise', 'callback', 'eventloop', 'microtask', 'thread', 'worker', 'mutex',
  'electron', 'vencord', 'plugin', 'sidebar', 'discord', 'gateway', 'flux', 'store', 'dispatcher',
  'release', 'hotfix', 'patch', 'v1', 'v2', 'staging', 'production', 'canary', 'rollback', 'ci', 'cd',
  'incident', 'outage', 'postmortem', 'alert', 'pagerduty', 'grafana', 'prometheus', 'datadog', 'sentry',
  'flaky', 'mock', 'stub', 'fixture', 'assertion', 'coverage', 'unit', 'integration', 'e2e',
  'vector', 'embedding', 'bm25', 'similarity', 'cosine', 'reranking', 'mmr', 'tokenization', 'idf',
  'lora', 'llm', 'transformer', 'attention', 'prompt', 'inference', 'quantization', 'gpu', 'cuda', 'h100',
];

export const DISCORD_EXPRESSIONS = [
  ':tada:', ':fire:', ':rocket:', ':eyes:', ':thinking:', ':sob:', ':joy:', ':skull:', ':100:', ':sparkles:',
  'lmao', 'gg', 'lgtm', 'tbh', 'imo', 'wdyt', 'afk', 'brb', 'fwiw', 'ptal', 'wip', 'bump', 'ping', 'pong',
  'https://github.com/vencord/vencord', 'https://discord.com', 'https://docs.vencord.dev',
];

// ============================================================================
// 3. GROUND-TRUTH TEST NEEDLE DEFINITIONS
// ============================================================================

export interface TestNeedle {
  id: string;
  category: 'secret' | 'otp' | 'multiterm' | 'cluster' | 'pattern' | 'scope_forbidden';
  name: string;
  targetMessageId: string;
  channelId: string;
  query: string;
  pattern?: string;
  content?: string;
  expectedSnippets: string[];
  isForbidden?: boolean;
}

export interface ThematicCluster {
  id: string;
  name: string;
  channelId: string;
  query: string;
  targetMessageIds: string[];
  description: string;
}

export const TEST_NEEDLES: TestNeedle[] = [
  // --- Group A: Exact Secrets & Keys ---
  {
    id: 'needle_secret_1',
    category: 'secret',
    name: 'Guest Wifi Password',
    targetMessageId: 'needle_msg_sec_1',
    channelId: 'guild_1_ch_general',
    query: 'wifi password for guest office',
    expectedSnippets: ['wifi password for guest office is RedwoodSummer42'],
  },
  {
    id: 'needle_secret_2',
    category: 'secret',
    name: 'Backup Encryption Key',
    targetMessageId: 'needle_msg_sec_2',
    channelId: 'guild_5_ch_incidents',
    query: 'backup encryption key',
    expectedSnippets: ['backup encryption key: enc_sec_0981247a8'],
  },
  {
    id: 'needle_secret_3',
    category: 'secret',
    name: 'Audio Mixer Memory Leak Bug',
    targetMessageId: 'needle_msg_sec_3',
    channelId: 'guild_1_ch_dev',
    query: 'CRITICAL_BUG_ID_789412 audio mixer memory leak',
    expectedSnippets: ['CRITICAL_BUG_ID_789412: memory leak in audio mixer'],
  },
  {
    id: 'needle_secret_4',
    category: 'secret',
    name: 'Stripe Live Webhook Secret',
    targetMessageId: 'needle_msg_sec_4',
    channelId: 'guild_2_ch_architecture',
    query: 'STRIPE_WEBHOOK_SECRET_LIVE_98127391283',
    expectedSnippets: ['STRIPE_WEBHOOK_SECRET_LIVE_98127391283'],
  },
  {
    id: 'needle_secret_5',
    category: 'secret',
    name: 'Advisory Lock Bypass Flag',
    targetMessageId: 'needle_msg_sec_5',
    channelId: 'guild_5_ch_devops',
    query: 'database migration lock contention bypass flag',
    expectedSnippets: ['database migration lock contention bypass flag: --force-skip-advisory-lock-9912'],
  },

  // --- Group B: Exact Verification Codes & OTPs ---
  {
    id: 'needle_otp_1',
    category: 'otp',
    name: '2FA Verification Code',
    targetMessageId: 'needle_msg_otp_1',
    channelId: 'dm_alice',
    query: '2FA verification code',
    pattern: '\\b\\d{6}\\b',
    expectedSnippets: ['Here is your 2FA verification code: 582910'],
  },
  {
    id: 'needle_otp_2',
    category: 'otp',
    name: 'Emergency Recovery Code',
    targetMessageId: 'needle_msg_otp_2',
    channelId: 'dm_bob',
    query: 'emergency recovery code',
    pattern: '\\b\\d{6}\\b',
    expectedSnippets: ['emergency recovery code: 491024 valid for 10 minutes'],
  },
  {
    id: 'needle_otp_3',
    category: 'otp',
    name: 'Staging Server Login PIN',
    targetMessageId: 'needle_msg_otp_3',
    channelId: 'gdm_alpha',
    query: 'login confirmation PIN staging server',
    pattern: '\\b\\d{6}\\b',
    expectedSnippets: ['login confirmation PIN: 739102 for staging server'],
  },
  {
    id: 'needle_otp_4',
    category: 'otp',
    name: 'Wire Transfer Auth Number',
    targetMessageId: 'needle_msg_otp_4',
    channelId: 'dm_charlie',
    query: 'wire transfer authorization number',
    pattern: '\\b\\d{6}\\b',
    expectedSnippets: ['wire transfer authorization number 849201'],
  },
  {
    id: 'needle_otp_5',
    category: 'otp',
    name: 'Single-Use OTP Code',
    targetMessageId: 'needle_msg_otp_5',
    channelId: 'guild_1_ch_general',
    query: 'single-use OTP code',
    pattern: '\\b\\d{6}\\b',
    expectedSnippets: ['single-use OTP code 193847'],
  },

  // --- Group C: Multi-Term & Conversational Nuance ---
  {
    id: 'needle_multi_1',
    category: 'multiterm',
    name: 'Denver Flight Connection 3-5 Mins',
    targetMessageId: 'needle_msg_multi_1',
    channelId: 'guild_7_ch_travel',
    query: 'united connection 3-5 minutes Denver gate B24',
    expectedSnippets: ['United flight connection in Denver was only 3-5 minutes, barely made it to gate B24!'],
  },
  {
    id: 'needle_multi_2',
    category: 'multiterm',
    name: 'Delta Flight Connection Atlanta',
    targetMessageId: 'needle_msg_multi_2',
    channelId: 'guild_7_ch_travel',
    query: 'delta flight connection atlanta terminal T',
    expectedSnippets: ['Flying Delta next week, connection is 45 minutes in Atlanta terminal T.'],
  },
  {
    id: 'needle_multi_3',
    category: 'multiterm',
    name: 'Docker Postgres Port Conflict',
    targetMessageId: 'needle_msg_multi_3',
    channelId: 'guild_5_ch_devops',
    query: 'docker compose postgres port conflict 5432 mapped 5433',
    expectedSnippets: ['Docker compose postgres port conflict on 5432 resolved by mapping to 5433.'],
  },
  {
    id: 'needle_multi_4',
    category: 'multiterm',
    name: 'Quarterly Roadmap Sync Notes',
    targetMessageId: 'needle_msg_multi_4',
    channelId: 'guild_2_ch_architecture',
    query: 'quarterly roadmap sync meeting notes Q3 search indexing',
    expectedSnippets: ['Quarterly roadmap sync meeting notes Q3 finalized: prioritizing search indexing.'],
  },
  {
    id: 'needle_multi_5',
    category: 'multiterm',
    name: 'Kafka Consumer Lag Spike',
    targetMessageId: 'needle_msg_multi_5',
    channelId: 'guild_5_ch_incidents',
    query: 'kafka consumer group rebalance storm lag spike',
    expectedSnippets: ['Kafka consumer group rebalance storm caused 45 second lag spike.'],
  },

  // --- Group E: Structured Patterns (Regex & Extraction) ---
  {
    id: 'needle_pattern_email',
    category: 'pattern',
    name: 'Security Ops Email',
    targetMessageId: 'needle_msg_pat_email',
    channelId: 'guild_9_ch_security_alerts',
    query: 'contact security ops email',
    pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
    content: 'contact security ops email at contact_sec_ops@internal.vencord.dev',
    expectedSnippets: ['contact_sec_ops@internal.vencord.dev'],
  },
  {
    id: 'needle_pattern_phone',
    category: 'pattern',
    name: 'Emergency Oncall Phone',
    targetMessageId: 'needle_msg_pat_phone',
    channelId: 'guild_5_ch_incidents',
    query: 'emergency oncall phone number',
    pattern: '\\+1-\\d{3}-\\d{3}-\\d{4}',
    content: 'emergency oncall phone number: +1-555-839-2041',
    expectedSnippets: ['+1-555-839-2041'],
  },
  {
    id: 'needle_pattern_ip',
    category: 'pattern',
    name: 'Staging Server IP',
    targetMessageId: 'needle_msg_pat_ip',
    channelId: 'guild_5_ch_devops',
    query: 'staging internal server IP address',
    pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
    content: 'staging internal server IP address is 192.168.1.100',
    expectedSnippets: ['192.168.1.100'],
  },
  {
    id: 'needle_pattern_git_sha',
    category: 'pattern',
    name: 'Release Git Commit SHA',
    targetMessageId: 'needle_msg_pat_sha',
    channelId: 'guild_1_ch_dev',
    query: 'release hotfix commit hash',
    pattern: '\\b[0-9a-f]{40}\\b',
    content: 'release hotfix commit hash is 7a3f89b1c4e20d98a123456789abcdef01234567',
    expectedSnippets: ['7a3f89b1c4e20d98a123456789abcdef01234567'],
  },
  {
    id: 'needle_pattern_pin',
    category: 'pattern',
    name: 'Office Door 4-Digit PIN',
    targetMessageId: 'needle_msg_pat_pin',
    channelId: 'guild_1_ch_general',
    query: 'office door 4-digit PIN code',
    pattern: '\\b\\d{4}\\b',
    content: 'office door 4-digit PIN code: 8492',
    expectedSnippets: ['8492'],
  },

  // --- Group F: Scope Isolation & Forbidden Channels (10 Needles) ---
  {
    id: 'needle_forbidden_1',
    category: 'scope_forbidden',
    name: 'Classified Vault Secret Key 001',
    targetMessageId: 'forbidden_msg_1',
    channelId: 'forbidden_admin_vault',
    query: 'CLASSIFIED_TOP_SECRET_VAULT_KEY_001',
    expectedSnippets: ['CLASSIFIED_TOP_SECRET_VAULT_KEY_001: supersecret_admin_token'],
    isForbidden: true,
  },
  {
    id: 'needle_forbidden_2',
    category: 'scope_forbidden',
    name: 'Payroll Salary Data 002',
    targetMessageId: 'forbidden_msg_2',
    channelId: 'forbidden_payroll',
    query: 'FORBIDDEN_PAYROLL_SALARY_DATA_002',
    expectedSnippets: ['FORBIDDEN_PAYROLL_SALARY_DATA_002: executive bonus figures'],
    isForbidden: true,
  },
  {
    id: 'needle_forbidden_3',
    category: 'scope_forbidden',
    name: 'Private HR Investigation Note 003',
    targetMessageId: 'forbidden_msg_3',
    channelId: 'forbidden_hr_investigation',
    query: 'PRIVATE_HR_INVESTIGATION_NOTE_003',
    expectedSnippets: ['PRIVATE_HR_INVESTIGATION_NOTE_003: confidential inquiry notes'],
    isForbidden: true,
  },
  {
    id: 'needle_forbidden_4',
    category: 'scope_forbidden',
    name: 'Restricted Root API Token 004',
    targetMessageId: 'forbidden_msg_4',
    channelId: 'forbidden_admin_vault',
    query: 'RESTRICTED_API_TOKEN_ROOT_004',
    expectedSnippets: ['RESTRICTED_API_TOKEN_ROOT_004: root_master_key_991823'],
    isForbidden: true,
  },
  {
    id: 'needle_forbidden_5',
    category: 'scope_forbidden',
    name: 'Unauthorized DM Private Chat 005',
    targetMessageId: 'forbidden_msg_5',
    channelId: 'unauthorized_dm_99',
    query: 'UNAUTHORIZED_DM_SECRET_005',
    expectedSnippets: ['UNAUTHORIZED_DM_SECRET_005: secret conversation in foreign DM'],
    isForbidden: true,
  },
  {
    id: 'needle_forbidden_6',
    category: 'scope_forbidden',
    name: 'Executive Strategy Leak 006',
    targetMessageId: 'forbidden_msg_6',
    channelId: 'forbidden_exec_lounge',
    query: 'EXECUTIVE_MERGER_STRATEGY_LEAK_006',
    expectedSnippets: ['EXECUTIVE_MERGER_STRATEGY_LEAK_006: acquisition terms'],
    isForbidden: true,
  },
  {
    id: 'needle_forbidden_7',
    category: 'scope_forbidden',
    name: 'Private Red Team Exploit Payload 007',
    targetMessageId: 'forbidden_msg_7',
    channelId: 'forbidden_redteam_exploits',
    query: 'ZERO_DAY_EXPLOIT_PAYLOAD_007',
    expectedSnippets: ['ZERO_DAY_EXPLOIT_PAYLOAD_007: remote execution vector'],
    isForbidden: true,
  },
  {
    id: 'needle_forbidden_8',
    category: 'scope_forbidden',
    name: 'Board Member Notes 008',
    targetMessageId: 'forbidden_msg_8',
    channelId: 'forbidden_board_room',
    query: 'CONFIDENTIAL_BOARD_MEETING_MINUTES_008',
    expectedSnippets: ['CONFIDENTIAL_BOARD_MEETING_MINUTES_008: board decisions'],
    isForbidden: true,
  },
  {
    id: 'needle_forbidden_9',
    category: 'scope_forbidden',
    name: 'Customer PII Export 009',
    targetMessageId: 'forbidden_msg_9',
    channelId: 'forbidden_pii_dump',
    query: 'RESTRICTED_CUSTOMER_PII_EXPORT_009',
    expectedSnippets: ['RESTRICTED_CUSTOMER_PII_EXPORT_009: credit cards and ssn'],
    isForbidden: true,
  },
  {
    id: 'needle_forbidden_10',
    category: 'scope_forbidden',
    name: 'Database Master Password 010',
    targetMessageId: 'forbidden_msg_10',
    channelId: 'forbidden_admin_vault',
    query: 'PROD_DB_SUPERUSER_PASSWORD_010',
    expectedSnippets: ['PROD_DB_SUPERUSER_PASSWORD_010: postgres_root_P@ssw0rd99'],
    isForbidden: true,
  },
];

export const THEMATIC_CLUSTERS: ThematicCluster[] = [
  {
    id: 'cluster_postgres_migration',
    name: 'PostgreSQL Migration & Lock Contention',
    channelId: 'guild_5_ch_devops',
    query: 'database performance drop and lock contention during migration',
    targetMessageIds: [], // Populated during corpus generation
    description: '10 messages discussing Postgres table locks, transaction timeouts, and advisory lock bypasses',
  },
  {
    id: 'cluster_zustand_migration',
    name: 'Frontend State Migration (Redux to Zustand)',
    channelId: 'guild_1_ch_frontend',
    query: 'frontend state management migration from redux to zustand',
    targetMessageIds: [],
    description: '10 messages discussing boilerplate reduction, store slices, and bundle size improvements',
  },
  {
    id: 'cluster_auth_incident',
    name: 'Auth Microservice Outage Postmortem',
    channelId: 'guild_5_ch_incidents',
    query: 'auth service outage expired jwt signing certificate postmortem',
    targetMessageIds: [],
    description: '10 messages discussing expired RSA-256 cert, cert-manager failure, and 503 errors',
  },
  {
    id: 'cluster_tokyo_itinerary',
    name: 'Tokyo Vacation Travel Itinerary',
    channelId: 'guild_7_ch_travel',
    query: 'tokyo to kyoto bullet train travel itinerary and hotel reservations',
    targetMessageIds: [],
    description: '10 messages discussing Shinkansen reservations, JR Pass, Shinjuku hotels, and ramen shops',
  },
  {
    id: 'cluster_lora_finetuning',
    name: 'LLM LoRA Fine-Tuning on H100',
    channelId: 'guild_6_ch_ai_research',
    query: 'llm fine-tuning lora hyperparameters on h100 gpu cluster',
    targetMessageIds: [],
    description: '10 messages discussing LoRA rank 16, learning rate cosine warmup, and FlashAttention-2',
  },
];

// ============================================================================
// 4. SYNTHETIC 100K+ CORPUS GENERATOR
// ============================================================================

export interface GeneratedCorpus {
  messages: DiscordMessage[];
  topology: BenchmarkTopology;
  needles: TestNeedle[];
  clusters: ThematicCluster[];
  stats: {
    totalMessages: number;
    totalGuilds: number;
    totalChannels: number;
    totalDMs: number;
    totalAuthors: number;
    burstCount: number;
    standaloneCount: number;
    generationTimeMs: number;
  };
}

export function generateSyntheticCorpus(targetCount: number = 100_000, seed: number = 421098): GeneratedCorpus {
  const startTime = Date.now();
  const rand = createPRNG(seed);

  // 1. Build Users (150 users)
  const users: DiscordUser[] = [];
  const predefinedUsers = [
    { id: 'user_raymond', username: 'raymond', globalName: 'Raymond' },
    { id: 'user_alice', username: 'alice', globalName: 'Alice Chen' },
    { id: 'user_bob', username: 'bob', globalName: 'Bob Smith' },
    { id: 'user_charlie', username: 'charlie', globalName: 'Charlie Brown' },
    { id: 'user_mr_panda', username: 'mr.panda', globalName: 'Mr Panda' },
    { id: 'user_secops', username: 'secops', globalName: 'Security Ops' },
    { id: 'user_bot', username: 'authbot', globalName: 'Auth Bot', bot: true },
  ];

  for (const u of predefinedUsers) {
    users.push(u);
  }

  for (let i = predefinedUsers.length + 1; i <= 150; i++) {
    users.push({
      id: `user_${i}`,
      username: `dev_${i}`,
      globalName: `Developer ${i}`,
      avatar: `https://cdn.discordapp.com/avatars/user_${i}/avatar.png`,
    });
  }

  // 2. Build Guilds (10 guilds) & Channels (50 guild channels)
  const guilds = GUILD_NAMES.map((name, index) => ({
    id: `guild_${index + 1}`,
    name,
  }));

  const channels: BenchmarkTopology['channels'] = [];
  const channelSubnames = ['general', 'dev', 'architecture', 'devops', 'incidents', 'frontend', 'security_alerts', 'travel', 'ai_research', 'roadmap'];

  const guildChannelMap: Record<string, string[]> = {
    guild_1: ['general', 'dev', 'frontend', 'architecture', 'random'],
    guild_2: ['general', 'architecture', 'roadmap', 'feedback', 'random'],
    guild_3: ['general', 'gaming', 'clips', 'lounge', 'random'],
    guild_4: ['general', 'dev', 'releases', 'code_review', 'random'],
    guild_5: ['general', 'incidents', 'devops', 'infra', 'random'],
    guild_6: ['general', 'ai_research', 'models', 'papers', 'random'],
    guild_7: ['general', 'travel', 'community', 'events', 'random'],
    guild_8: ['general', 'crypto', 'trading', 'defi', 'random'],
    guild_9: ['general', 'security_alerts', 'redteam', 'audit', 'random'],
    guild_10: ['general', 'memes', 'offtopic', 'music', 'random'],
  };

  guilds.forEach((guild) => {
    const subnames = guildChannelMap[guild.id] || ['general', 'dev', 'random'];
    subnames.forEach((subname) => {
      channels.push({
        id: `${guild.id}_ch_${subname}`,
        name: subname,
        guildId: guild.id,
        type: ChannelType.GUILD_TEXT,
        topic: `Official channel for ${subname} in ${guild.name}`,
      });
    });
  });

  // Forbidden channels for scope isolation testing
  channels.push(
    { id: 'forbidden_admin_vault', name: 'admin-vault', guildId: 'guild_9', type: ChannelType.GUILD_TEXT, topic: 'Strictly restricted' },
    { id: 'forbidden_payroll', name: 'exec-payroll', guildId: 'guild_9', type: ChannelType.GUILD_TEXT, topic: 'Strictly restricted' },
    { id: 'forbidden_hr_investigation', name: 'hr-investigation', guildId: 'guild_9', type: ChannelType.GUILD_TEXT, topic: 'Strictly restricted' },
    { id: 'forbidden_exec_lounge', name: 'exec-lounge', guildId: 'guild_9', type: ChannelType.GUILD_TEXT, topic: 'Strictly restricted' },
    { id: 'forbidden_redteam_exploits', name: 'redteam-exploits', guildId: 'guild_9', type: ChannelType.GUILD_TEXT, topic: 'Strictly restricted' },
    { id: 'forbidden_board_room', name: 'board-room', guildId: 'guild_9', type: ChannelType.GUILD_TEXT, topic: 'Strictly restricted' },
    { id: 'forbidden_pii_dump', name: 'pii-dump', guildId: 'guild_9', type: ChannelType.GUILD_TEXT, topic: 'Strictly restricted' },
  );

  // 3. Build DMs (15 1-on-1 DMs, 10 Group DMs = 25 total)
  const dms: BenchmarkTopology['dms'] = [
    { id: 'dm_alice', name: '@Alice Chen', recipients: ['user_alice'], isGroupDM: false },
    { id: 'dm_bob', name: '@Bob Smith', recipients: ['user_bob'], isGroupDM: false },
    { id: 'dm_charlie', name: '@Charlie Brown', recipients: ['user_charlie'], isGroupDM: false },
    { id: 'dm_panda', name: '@Mr Panda', recipients: ['user_mr_panda'], isGroupDM: false },
    { id: 'dm_secops', name: '@Security Ops', recipients: ['user_secops'], isGroupDM: false },
    { id: 'unauthorized_dm_99', name: '@Stranger 99', recipients: ['user_99'], isGroupDM: false },
  ];

  for (let i = 6; i <= 15; i++) {
    dms.push({
      id: `dm_user_${i}`,
      name: `@Developer ${i}`,
      recipients: [`user_${i}`],
      isGroupDM: false,
    });
  }

  const groupDMNames = [
    { id: 'gdm_alpha', name: 'Project Alpha', recipients: ['user_alice', 'user_bob', 'user_raymond'] },
    { id: 'gdm_gaming', name: 'Game Night', recipients: ['user_alice', 'user_charlie'] },
    { id: 'gdm_infra', name: 'Infra Oncall', recipients: ['user_bob', 'user_secops'] },
    { id: 'gdm_frontend', name: 'Frontend Crew', recipients: ['user_alice', 'user_raymond', 'user_10'] },
    { id: 'gdm_crypto', name: 'Crypto Chat', recipients: ['user_11', 'user_12'] },
    { id: 'gdm_travel', name: 'Tokyo Trip 2026', recipients: ['user_raymond', 'user_alice'] },
    { id: 'gdm_books', name: 'Book Club', recipients: ['user_14', 'user_15'] },
    { id: 'gdm_lunch', name: 'Lunch Buddies', recipients: ['user_alice', 'user_bob', 'user_mr_panda'] },
    { id: 'gdm_hackathon', name: 'Hackathon 2026', recipients: ['user_raymond', 'user_10', 'user_20'] },
    { id: 'gdm_music', name: 'Audio & Music', recipients: ['user_30', 'user_31'] },
  ];

  groupDMNames.forEach((g) => dms.push({ ...g, isGroupDM: true }));

  const topology: BenchmarkTopology = { guilds, channels, dms, users };

  // 4. Generate Messages
  const messages: DiscordMessage[] = new Array(targetCount);
  const baseTimestamp = new Date('2025-01-01T00:00:00.000Z').getTime();
  const yearMs = 365 * 24 * 60 * 60 * 1000;

  let msgIdx = 0;
  let burstCount = 0;
  let standaloneCount = 0;

  // Helper for generating random message text with Zipfian distribution
  const generateRandomSentence = (minWords: number = 4, maxWords: number = 25): string => {
    const wordCount = Math.floor(rand() * (maxWords - minWords + 1)) + minWords;
    const words: string[] = [];
    for (let w = 0; w < wordCount; w++) {
      // 65% common words, 25% technical jargon, 10% expressions
      const roll = rand();
      if (roll < 0.65) {
        // Zipfian distribution: pick lower indices with higher probability
        const zipfIdx = Math.floor(Math.pow(rand(), 2.2) * VOCABULARY_COMMON.length);
        words.push(VOCABULARY_COMMON[zipfIdx] || 'the');
      } else if (roll < 0.90) {
        const techIdx = Math.floor(Math.pow(rand(), 1.8) * VOCABULARY_TECHNICAL.length);
        words.push(VOCABULARY_TECHNICAL[techIdx] || 'database');
      } else {
        const exprIdx = Math.floor(rand() * DISCORD_EXPRESSIONS.length);
        words.push(DISCORD_EXPRESSIONS[exprIdx]);
      }
    }
    return words.join(' ');
  };

  const generateAttachments = (id: string): DiscordAttachment[] => {
    const roll = rand();
    if (roll < 0.85) return []; // 85% no attachments
    if (roll < 0.95) {
      return [{
        id: `att_${id}_1`,
        filename: rand() > 0.5 ? 'screenshot.png' : 'diagram.webp',
        size: Math.floor(rand() * 500_000) + 10_000,
        url: `https://cdn.discordapp.com/attachments/${id}/image.png`,
        proxy_url: `https://media.discordapp.net/attachments/${id}/image.png`,
        content_type: 'image/png',
      }];
    }
    return [{
      id: `att_${id}_2`,
      filename: 'spec_document.pdf',
      size: Math.floor(rand() * 2_000_000) + 50_000,
      url: `https://cdn.discordapp.com/attachments/${id}/spec_document.pdf`,
      proxy_url: `https://media.discordapp.net/attachments/${id}/spec_document.pdf`,
      content_type: 'application/pdf',
    }];
  };

  const generateEmbeds = (id: string): DiscordEmbed[] => {
    if (rand() < 0.92) return []; // 92% no embeds
    return [{
      title: 'Automated Build & Test Report',
      description: `CI Pipeline completed for commit ${id.slice(-8)}. Status: SUCCESS`,
      url: 'https://ci.internal.vencord.dev/builds',
    }];
  };

  // 70% messages in conversational bursts
  const allowedChannelIds = channels.map((c) => c.id).concat(dms.map((d) => d.id));

  while (msgIdx < targetCount) {
    const isBurst = rand() < 0.70 && msgIdx + 10 < targetCount;
    if (isBurst) {
      burstCount++;
      const burstSize = Math.min(Math.floor(rand() * 15) + 5, targetCount - msgIdx);
      const channelId = allowedChannelIds[Math.floor(rand() * allowedChannelIds.length)];
      const numParticipants = Math.floor(rand() * 3) + 2;
      const participants: DiscordUser[] = [];
      for (let p = 0; p < numParticipants; p++) {
        participants.push(users[Math.floor(rand() * users.length)]);
      }

      let burstTime = baseTimestamp + Math.floor(rand() * yearMs);
      let lastMsgId: string | undefined;

      for (let b = 0; b < burstSize; b++) {
        const author = participants[Math.floor(rand() * participants.length)];
        const currentId = `msg_${msgIdx + 1}`;
        burstTime += Math.floor(rand() * 40_000) + 5_000; // 5s to 45s between messages

        const hasReply = b > 0 && rand() < 0.40 && Boolean(lastMsgId);

        messages[msgIdx] = {
          id: currentId,
          channel_id: channelId,
          guild_id: channelId.startsWith('guild_') ? channelId.split('_ch_')[0] : undefined,
          author,
          content: generateRandomSentence(),
          timestamp: new Date(burstTime).toISOString(),
          attachments: generateAttachments(currentId),
          embeds: generateEmbeds(currentId),
          mentions: rand() < 0.15 ? [participants[0]] : [],
          pinned: rand() < 0.01,
          message_reference: hasReply ? { channel_id: channelId, message_id: lastMsgId } : undefined,
        };

        lastMsgId = currentId;
        msgIdx++;
      }
    } else {
      standaloneCount++;
      const channelId = allowedChannelIds[Math.floor(rand() * allowedChannelIds.length)];
      const author = users[Math.floor(rand() * users.length)];
      const currentId = `msg_${msgIdx + 1}`;
      const msgTime = baseTimestamp + Math.floor(rand() * yearMs);

      messages[msgIdx] = {
        id: currentId,
        channel_id: channelId,
        guild_id: channelId.startsWith('guild_') ? channelId.split('_ch_')[0] : undefined,
        author,
        content: generateRandomSentence(),
        timestamp: new Date(msgTime).toISOString(),
        attachments: generateAttachments(currentId),
        embeds: generateEmbeds(currentId),
        mentions: [],
        pinned: rand() < 0.01,
      };

      msgIdx++;
    }
  }

  // 5. Embed Exact Needles at Specific Depths
  const needlePositions = [
    { needleIdx: 0, depth: Math.floor(targetCount * 0.08) },
    { needleIdx: 1, depth: Math.floor(targetCount * 0.18) },
    { needleIdx: 2, depth: Math.floor(targetCount * 0.28) },
    { needleIdx: 3, depth: Math.floor(targetCount * 0.38) },
    { needleIdx: 4, depth: Math.floor(targetCount * 0.48) },
    { needleIdx: 5, depth: Math.floor(targetCount * 0.55) },
    { needleIdx: 6, depth: Math.floor(targetCount * 0.62) },
    { needleIdx: 7, depth: Math.floor(targetCount * 0.69) },
    { needleIdx: 8, depth: Math.floor(targetCount * 0.76) },
    { needleIdx: 9, depth: Math.floor(targetCount * 0.83) },
    { needleIdx: 10, depth: Math.floor(targetCount * 0.89) },
    { needleIdx: 11, depth: Math.floor(targetCount * 0.91) },
    { needleIdx: 12, depth: Math.floor(targetCount * 0.93) },
    { needleIdx: 13, depth: Math.floor(targetCount * 0.95) },
    { needleIdx: 14, depth: Math.floor(targetCount * 0.97) },
    { needleIdx: 15, depth: Math.floor(targetCount * 0.12) }, // Pattern email
    { needleIdx: 16, depth: Math.floor(targetCount * 0.22) }, // Pattern phone
    { needleIdx: 17, depth: Math.floor(targetCount * 0.32) }, // Pattern IP
    { needleIdx: 18, depth: Math.floor(targetCount * 0.44) }, // Pattern SHA
    { needleIdx: 19, depth: Math.floor(targetCount * 0.52) }, // Pattern PIN
    // Forbidden Needles (20 to 29)
    { needleIdx: 20, depth: Math.floor(targetCount * 0.05) },
    { needleIdx: 21, depth: Math.floor(targetCount * 0.15) },
    { needleIdx: 22, depth: Math.floor(targetCount * 0.25) },
    { needleIdx: 23, depth: Math.floor(targetCount * 0.35) },
    { needleIdx: 24, depth: Math.floor(targetCount * 0.45) },
    { needleIdx: 25, depth: Math.floor(targetCount * 0.58) },
    { needleIdx: 26, depth: Math.floor(targetCount * 0.68) },
    { needleIdx: 27, depth: Math.floor(targetCount * 0.78) },
    { needleIdx: 28, depth: Math.floor(targetCount * 0.88) },
    { needleIdx: 29, depth: Math.floor(targetCount * 0.98) },
  ];

  needlePositions.forEach(({ needleIdx, depth }) => {
    const needle = TEST_NEEDLES[needleIdx];
    if (!needle) return;

    const targetMsg = messages[depth];
    if (!targetMsg) return;

    needle.targetMessageId = targetMsg.id;
    targetMsg.channel_id = needle.channelId;
    targetMsg.guild_id = needle.channelId.startsWith('guild_') ? needle.channelId.split('_ch_')[0] : undefined;
    targetMsg.content = needle.content || needle.expectedSnippets[0];
    if (needle.id === 'needle_multi_1' || needle.id === 'needle_multi_2') {
      targetMsg.author = users.find((u) => u.id === 'user_raymond') || targetMsg.author;
    }
  });

  // 6. Embed Thematic Clusters (5 clusters, 10 messages each in contiguous burst)
  THEMATIC_CLUSTERS.forEach((cluster, cIdx) => {
    cluster.targetMessageIds = [];
    const startDepth = Math.floor(targetCount * (0.10 + cIdx * 0.16));
    const clusterBaseTime = baseTimestamp + Math.floor(rand() * yearMs);
    let clusterSentences: string[] = [];

    switch (cluster.id) {
      case 'cluster_postgres_migration':
        clusterSentences = [
          'Starting postgres table schema migration on production cluster.',
          'Noticeable database performance drop and lock contention during migration.',
          'ALTER TABLE ADD COLUMN is waiting on exclusive table lock for users_v2.',
          'Checking pg_stat_activity for blocked queries and high CPU load.',
          'Connection pool exhaustion occurred due to queries piling up behind the lock.',
          'Advisory lock contention detected on migration runner node.',
          'We need to set lock_timeout = 2s to prevent query pileups.',
          'Applying zero-downtime migration strategy using temporary shadow table.',
          'Postgres CPU dropped back to normal 12% after releasing lock.',
          'Schema migration successfully completed without dropping traffic.',
        ];
        break;
      case 'cluster_zustand_migration':
        clusterSentences = [
          'Proposing frontend state management migration from Redux Saga to Zustand.',
          'Redux boilerplate was getting unsustainable across our 40 feature slices.',
          'Zustand gives us concise store hooks with zero unnecessary re-renders.',
          'Bundle size dropped by 42kb after stripping Redux Toolkit and Saga runtime.',
          'Migrated auth state and user preferences slice to create() store.',
          'Optimistic UI state updates are much simpler to express in Zustand actions.',
          'Added devtools middleware for debugging state transitions in development.',
          'All React components converted cleanly from useSelector to useStore.',
          'Code review approved for PR #412 zustand state overhaul.',
          'State management migration from redux to zustand completed successfully.',
        ];
        break;
      case 'cluster_auth_incident':
        clusterSentences = [
          'PAGERDUTY ALERT: Auth service outage spike in 503 Service Unavailable errors.',
          'Root cause investigation: expired RSA-256 JWT signing certificate.',
          'Automated cert-manager rotation failed due to invalid kubernetes RBAC permissions.',
          'Users are unable to refresh tokens or log into dashboard.',
          'Emergency hotfix: manually provisioned updated X.509 signing certificate.',
          'Auth microservice restarting pods to reload updated JWT keystore.',
          'Login success rate restored to 99.98% across all regions.',
          'Postmortem action item: add prometheus alert for cert expiration < 14 days.',
          'Auditing automated renewal pipeline to prevent repeat outages.',
          'Finalized auth service outage expired jwt certificate incident postmortem report.',
        ];
        break;
      case 'cluster_tokyo_itinerary':
        clusterSentences = [
          'Planning our Tokyo to Kyoto vacation travel itinerary for next spring.',
          'Booked 7-day whole Japan Rail Shinkansen bullet train passes.',
          'Reserved hotel rooms near Shinjuku station for easy subway transit.',
          'Purchased tickets for TeamLab Planets digital art museum in Toyosu.',
          'Added day trip to Nara deer park and Fushimi Inari shrine in Kyoto.',
          'Must-visit ramen spots: Rokurinsha in Tokyo Station and Ichiran Shibuya.',
          'Flight arrives at Haneda airport HND at 3pm on Tuesday.',
          'Looking into pocket wifi rental vs eSIM for international data roaming.',
          'Luggage forwarding service Takkyubin between Tokyo and Kyoto hotels.',
          'Vacation travel itinerary finalized with bullet train and hotel bookings.',
        ];
        break;
      case 'cluster_lora_finetuning':
        clusterSentences = [
          'Setting up LLM fine-tuning LoRA hyperparameters on 8x H100 GPU cluster.',
          'Using LoRA rank r=16 and alpha=32 with target modules q_proj and v_proj.',
          'Learning rate set to 2e-4 with cosine schedule and 100-step linear warmup.',
          'Enabled FlashAttention-2 and bfloat16 mixed precision for max throughput.',
          'Training loss decreased from 2.84 to 0.92 after 3 epochs on dataset.',
          'Gradient checkpointing reduced VRAM consumption to 38GB per H100 GPU.',
          'Evaluating validation perplexity and needle retrieval recall benchmark.',
          'Model fine-tuning converged smoothly without gradient explosion.',
          'Exported merged LoRA adapter weights for GGUF and AWQ quantization.',
          'Benchmark evaluation confirmed 94% recall on domain-specific question answering.',
        ];
        break;
    }

    clusterSentences.forEach((sentence, sIdx) => {
      const targetMsg = messages[startDepth + sIdx];
      if (targetMsg) {
        targetMsg.channel_id = cluster.channelId;
        targetMsg.guild_id = cluster.channelId.startsWith('guild_') ? cluster.channelId.split('_ch_')[0] : undefined;
        targetMsg.content = sentence;
        targetMsg.timestamp = new Date(clusterBaseTime + sIdx * 20_000).toISOString();
        if (sIdx > 0 && cluster.targetMessageIds.length > 0) {
          targetMsg.message_reference = {
            message_id: cluster.targetMessageIds[sIdx - 1],
            channel_id: cluster.channelId,
          };
        }
        cluster.targetMessageIds.push(targetMsg.id);
      }
    });
  });

  const generationTimeMs = Date.now() - startTime;

  return {
    messages,
    topology,
    needles: TEST_NEEDLES,
    clusters: THEMATIC_CLUSTERS,
    stats: {
      totalMessages: messages.length,
      totalGuilds: guilds.length,
      totalChannels: channels.length,
      totalDMs: dms.length,
      totalAuthors: users.length,
      burstCount,
      standaloneCount,
      generationTimeMs,
    },
  };
}

// ============================================================================
// 5. IN-MEMORY INVERTED INDEX & BM25 RETRIEVAL ENGINE
// ============================================================================

export const FLAG_IMAGE = 1 << 0;
export const FLAG_FILE = 1 << 1;
export const FLAG_LINK = 1 << 2;
export const FLAG_SOUND = 1 << 3;
export const FLAG_VIDEO = 1 << 4;
export const FLAG_PINNED = 1 << 5;

export interface StoredMessageRecord {
  docId: number;
  id: string;
  channelId: string;
  guildId?: string;
  authorId: string;
  authorName: string;
  timestamp: number;
  content: string;
  tokenLength: number;
  flags: number;
  replyParentId?: string;
  mentions?: string[];
}

export interface PostingList {
  docIds: number[];
  termFreqs: number[];
}

export interface IndexSearchQuery {
  query?: string;
  pattern?: string | RegExp;
  channelId?: string;
  guildWide?: boolean;
  authorId?: string;
  duringDate?: string;
  afterDate?: string | Date;
  beforeDate?: string | Date;
  has?: 'image' | 'sound' | 'video' | 'file' | 'link' | 'embed' | 'sticker';
  pinned?: boolean;
  mentions?: string;
  limit?: number;
  expandConversationalWindow?: number;
}

export interface ScoredSearchResult {
  message: DiscordMessage;
  score: number;
  bm25Score: number;
  exactBonus: number;
  recencyScore: number;
  matchedTokens: string[];
  extractedPatternMatches?: string[];
}

export class InMemoryBM25Index {
  public records: StoredMessageRecord[] = [];
  public docIdMap: Map<string, number> = new Map();
  public postings: Map<string, PostingList> = new Map();
  public totalTokens: number = 0;
  public avgDocLength: number = 0;

  // BM25 Hyperparameters
  public k1: number = 1.2;
  public b: number = 0.75;

  public clear(): void {
    this.records = [];
    this.docIdMap.clear();
    this.postings.clear();
    this.totalTokens = 0;
    this.avgDocLength = 0;
  }

  public tokenize(text: string): string[] {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[^\w\s\.-]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !VOCABULARY_COMMON.includes(t));
  }

  public indexMessage(msg: DiscordMessage): number {
    const existingDocId = this.docIdMap.get(msg.id);
    let flags = 0;
    if (msg.attachments?.some((a) => a.content_type?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(a.filename || ''))) flags |= FLAG_IMAGE;
    if (msg.attachments?.length && !(flags & FLAG_IMAGE)) flags |= FLAG_FILE;
    if (/https?:\/\/[^\s]+/i.test(msg.content || '') || msg.embeds?.some((e) => e.url)) flags |= FLAG_LINK;
    if (msg.attachments?.some((a) => a.content_type?.startsWith('audio/'))) flags |= FLAG_SOUND;
    if (msg.attachments?.some((a) => a.content_type?.startsWith('video/'))) flags |= FLAG_VIDEO;
    if (msg.pinned) flags |= FLAG_PINNED;

    const mentions = msg.mentions?.length ? msg.mentions.map((u) => u.id) : undefined;
    const timestamp = new Date(msg.timestamp).getTime();

    const fullText = `${msg.content || ''} ${msg.attachments?.map((a) => a.filename).join(' ') || ''} ${msg.embeds?.map((e) => `${e.title || ''} ${e.description || ''}`).join(' ') || ''}`;
    const tokens = this.tokenize(fullText);
    const tokenLength = tokens.length || 1;

    let docId: number;

    if (existingDocId !== undefined) {
      docId = existingDocId;
      const oldRecord = this.records[docId];
      this.totalTokens -= oldRecord.tokenLength;
      this.records[docId] = {
        docId,
        id: msg.id,
        channelId: msg.channel_id,
        guildId: msg.guild_id,
        authorId: msg.author?.id || '',
        authorName: msg.author?.globalName || msg.author?.username || '',
        timestamp,
        content: msg.content || '',
        tokenLength,
        flags,
        replyParentId: msg.message_reference?.message_id,
        mentions,
      };
    } else {
      docId = this.records.length;
      this.docIdMap.set(msg.id, docId);
      this.records.push({
        docId,
        id: msg.id,
        channelId: msg.channel_id,
        guildId: msg.guild_id,
        authorId: msg.author?.id || '',
        authorName: msg.author?.globalName || msg.author?.username || '',
        timestamp,
        content: msg.content || '',
        tokenLength,
        flags,
        replyParentId: msg.message_reference?.message_id,
        mentions,
      });
    }

    this.totalTokens += tokenLength;
    this.avgDocLength = this.totalTokens / this.records.length;

    // Count term frequencies
    const tfMap = new Map<string, number>();
    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) || 0) + 1);
    }

    // Update Inverted Index Postings
    for (const [term, tf] of tfMap.entries()) {
      let list = this.postings.get(term);
      if (!list) {
        list = { docIds: [], termFreqs: [] };
        this.postings.set(term, list);
      }
      list.docIds.push(docId);
      list.termFreqs.push(tf);
    }

    return docId;
  }

  public indexBatch(messages: DiscordMessage[]): { indexed: number; total: number; elapsedMs: number } {
    const t0 = Date.now();
    for (let i = 0; i < messages.length; i++) {
      this.indexMessage(messages[i]);
    }
    const elapsedMs = Date.now() - t0;
    return {
      indexed: messages.length,
      total: this.records.length,
      elapsedMs,
    };
  }

  public search(query: IndexSearchQuery, scope: CurrentScopeContext): ScoredSearchResult[] {
    const limit = query.limit || 25;
    const rawQuery = query.query?.trim() || '';
    const queryTokens = this.tokenize(rawQuery);
    const N = this.records.length;
    if (N === 0) return [];

    // Compile regex pattern if provided
    let patternRegex: RegExp | null = null;
    if (query.pattern) {
      if (query.pattern instanceof RegExp) {
        patternRegex = query.pattern;
      } else {
        try {
          patternRegex = new RegExp(query.pattern, 'gi');
        } catch {
          patternRegex = null;
        }
      }
    }

    // Determine allowed channels from scope
    const allowedChannels = new Set<string>();
    if (scope.channelId) {
      allowedChannels.add(scope.channelId);
    }
    if (scope.isGuild && scope.accessibleGuildChannels) {
      scope.accessibleGuildChannels.forEach((c) => allowedChannels.add(c.id));
    }
    if (scope.isDM && scope.explicitMutualGroupDMIds) {
      scope.explicitMutualGroupDMIds.forEach((id) => allowedChannels.add(id));
    }

    const candidateScores = new Map<number, { bm25: number; matchedTokens: string[] }>();

    // 1. Lexical Scoring via Inverted Index BM25
    if (queryTokens.length > 0) {
      for (const token of queryTokens) {
        const posting = this.postings.get(token);
        if (!posting) continue;

        const df = posting.docIds.length;
        // Robertson-Spärck Jones IDF formula with +1 smoothing
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0);

        for (let i = 0; i < posting.docIds.length; i++) {
          const docId = posting.docIds[i];
          const tf = posting.termFreqs[i];
          const record = this.records[docId];
          if (!record) continue;

          // Fail-closed Scope Filter
          if (!allowedChannels.has(record.channelId)) continue;

          const docLen = record.tokenLength;
          const bm25Score = idf * ((tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (docLen / (this.avgDocLength || 1)))));

          let entry = candidateScores.get(docId);
          if (!entry) {
            entry = { bm25: 0, matchedTokens: [] };
            candidateScores.set(docId, entry);
          }
          entry.bm25 += bm25Score;
          entry.matchedTokens.push(token);
        }
      }
    } else {
      // If query is empty but filters are present, evaluate all in-scope records
      for (let docId = 0; docId < this.records.length; docId++) {
        const record = this.records[docId];
        if (allowedChannels.has(record.channelId)) {
          candidateScores.set(docId, { bm25: 1.0, matchedTokens: [] });
        }
      }
    }

    // 2. Candidate Filtering & Composite Scoring
    const scoredCandidates: Array<{ docId: number; score: number; bm25: number; exactBonus: number; recency: number; matchedTokens: string[]; extractedPatternMatches?: string[] }> = [];
    const queryLower = rawQuery.toLowerCase();
    const now = Date.now();
    const T_SCALE = 30 * 24 * 60 * 60 * 1000; // 30 days recency scale

    for (const [docId, { bm25, matchedTokens }] of candidateScores.entries()) {
      const record = this.records[docId];
      if (!record) continue;

      // Channel filter check
      if (query.channelId && record.channelId !== query.channelId) continue;

      // Author filter check
      if (query.authorId && record.authorId !== query.authorId) continue;

      // Date filters
      if (query.duringDate) {
        const msgDate = new Date(record.timestamp).toISOString().slice(0, 10);
        if (msgDate !== query.duringDate) continue;
      }
      if (query.afterDate) {
        const afterMs = typeof query.afterDate === 'string' ? new Date(query.afterDate).getTime() : query.afterDate.getTime();
        if (record.timestamp < afterMs) continue;
      }
      if (query.beforeDate) {
        const beforeMs = typeof query.beforeDate === 'string' ? new Date(query.beforeDate).getTime() : query.beforeDate.getTime();
        if (record.timestamp > beforeMs) continue;
      }

      // Media filters
      if (query.has) {
        if (query.has === 'image' && !(record.flags & FLAG_IMAGE)) continue;
        if (query.has === 'file' && !(record.flags & FLAG_FILE)) continue;
        if (query.has === 'link' && !(record.flags & FLAG_LINK)) continue;
        if (query.has === 'sound' && !(record.flags & FLAG_SOUND)) continue;
        if (query.has === 'video' && !(record.flags & FLAG_VIDEO)) continue;
      }

      if (query.pinned !== undefined && Boolean(record.flags & FLAG_PINNED) !== query.pinned) continue;
      if (query.mentions && (!record.mentions || !record.mentions.includes(query.mentions))) continue;

      // Exact substring match bonus (+100)
      let exactBonus = 0;
      if (queryLower.length > 2 && record.content.toLowerCase().includes(queryLower)) {
        exactBonus = 100;
      }

      // Pattern / Regex match check
      let extractedPatternMatches: string[] | undefined;
      if (patternRegex) {
        patternRegex.lastIndex = 0;
        const matches: string[] = [];
        let match: RegExpExecArray | null;
        let guard = 0;
        while ((match = patternRegex.exec(record.content)) !== null && guard++ < 20) {
          if (match[0]) matches.push(match[0]);
          else patternRegex.lastIndex++;
        }
        if (matches.length === 0) {
          continue; // Failed pattern filter
        }
        extractedPatternMatches = Array.from(new Set(matches));
        exactBonus += 50;
      }

      // Recency exponential decay
      const ageMs = Math.max(0, now - record.timestamp);
      const recencyScore = Math.exp(-0.5 * (ageMs / T_SCALE));

      const totalScore = bm25 * 0.65 + exactBonus * 0.25 + recencyScore * 5.0;

      scoredCandidates.push({
        docId,
        score: totalScore,
        bm25,
        exactBonus,
        recency: recencyScore,
        matchedTokens,
        extractedPatternMatches,
      });
    }

    // Sort descending by score
    scoredCandidates.sort((a, b) => b.score - a.score);

    // 3. Conversational Window Expansion (Stage 3 of Retrieval Pipeline)
    const finalDocIds = new Set<number>();
    const results: ScoredSearchResult[] = [];

    const appendDoc = (record: StoredMessageRecord, candidateScore?: { score: number; bm25: number; exactBonus: number; recency: number; matchedTokens: string[]; extractedPatternMatches?: string[] }) => {
      if (finalDocIds.has(record.docId)) return;
      finalDocIds.add(record.docId);

      const discordMsg: DiscordMessage = {
        id: record.id,
        channel_id: record.channelId,
        guild_id: record.guildId,
        author: { id: record.authorId, username: record.authorName, globalName: record.authorName },
        content: record.content,
        timestamp: new Date(record.timestamp).toISOString(),
        attachments: (record.flags & (FLAG_IMAGE | FLAG_FILE)) ? [{ id: 'att_1', filename: (record.flags & FLAG_IMAGE) ? 'image.png' : 'file.pdf', size: 1024, url: '', proxy_url: '' }] : [],
        embeds: [],
        mentions: record.mentions ? record.mentions.map((id) => ({ id, username: id })) : [],
        pinned: Boolean(record.flags & FLAG_PINNED),
        message_reference: record.replyParentId ? { message_id: record.replyParentId, channel_id: record.channelId } : undefined,
        hit: true,
      };

      results.push({
        message: discordMsg,
        score: candidateScore ? candidateScore.score : 10.0,
        bm25Score: candidateScore ? candidateScore.bm25 : 0,
        exactBonus: candidateScore ? candidateScore.exactBonus : 0,
        recencyScore: candidateScore ? candidateScore.recency : 0,
        matchedTokens: candidateScore ? candidateScore.matchedTokens : [],
        extractedPatternMatches: candidateScore ? candidateScore.extractedPatternMatches : undefined,
      });
    };

    const windowSize = query.expandConversationalWindow || 0;

    for (const cand of scoredCandidates) {
      if (results.length >= limit && windowSize === 0) break;
      const record = this.records[cand.docId];
      if (!record) continue;

      appendDoc(record, cand);

      if (windowSize > 0) {
        // Expand contiguous burst in same channel
        const minDoc = Math.max(0, record.docId - windowSize);
        const maxDoc = Math.min(this.records.length - 1, record.docId + windowSize);
        for (let d = minDoc; d <= maxDoc; d++) {
          const adj = this.records[d];
          if (adj && adj.channelId === record.channelId && Math.abs(adj.timestamp - record.timestamp) < 30 * 60 * 1000) {
            appendDoc(adj);
          }
        }
      }
    }

    return results.slice(0, limit);
  }
}
