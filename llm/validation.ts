/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ToolDefinition } from '../types';
export class ToolArgumentError extends Error {
  name = 'ToolArgumentError';
}
/** Message IDs are interpolated into Discord REST paths, so they must be plain decimal snowflakes. */
const MESSAGE_ID_ARGUMENTS = new Set(['message_id', 'before_message_id', 'after_message_id']);
const NUMERIC_ID = /^\d{1,22}$/;

const HAS_SYNONYMS: Record<string, string> = {
  links: 'link',
  url: 'link',
  urls: 'link',
  images: 'image',
  img: 'image',
  imgs: 'image',
  photo: 'image',
  photos: 'image',
  pic: 'image',
  pics: 'image',
  picture: 'image',
  pictures: 'image',
  files: 'file',
  attachment: 'file',
  attachments: 'file',
  doc: 'file',
  docs: 'file',
  videos: 'video',
  vid: 'video',
  vids: 'video',
  audio: 'sound',
  voice: 'sound',
  sounds: 'sound',
  embeds: 'embed',
  stickers: 'sticker',
};

const SORT_ORDER_SYNONYMS: Record<string, string> = {
  newest: 'desc',
  latest: 'desc',
  descending: 'desc',
  oldest: 'asc',
  earliest: 'asc',
  ascending: 'asc',
};

const SORT_BY_SYNONYMS: Record<string, string> = {
  time: 'timestamp',
  date: 'timestamp',
  recent: 'timestamp',
  relevant: 'relevance',
  best: 'relevance',
};

function coerceKnownArgument(name: string, value: unknown, schema: any): unknown {
  if (schema.type === 'number' && typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  }
  if (schema.type === 'boolean' && typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (name === 'author_id' || name === 'mentions') {
      const m = /^<@!?(\d{1,22})>$/.exec(trimmed);
      if (m) return m[1];
    }
    if (name === 'channel_id') {
      const m = /^<#(\d{1,22})>$/.exec(trimmed);
      if (m) return m[1];
    }
    if (Array.isArray(schema.enum)) {
      const lowered = trimmed.toLowerCase();
      if (schema.enum.includes(lowered)) return lowered;
      if (name === 'has' && HAS_SYNONYMS[lowered]) return HAS_SYNONYMS[lowered];
      if (name === 'sort_order' && SORT_ORDER_SYNONYMS[lowered]) return SORT_ORDER_SYNONYMS[lowered];
      if (name === 'sort_by' && SORT_BY_SYNONYMS[lowered]) return SORT_BY_SYNONYMS[lowered];
    }
  }
  return value;
}

function validateValue(name: string, value: unknown, schema: any): void {
  const valid = schema.type === 'string'
    ? typeof value === 'string'
    : schema.type === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : schema.type === 'boolean'
        ? typeof value === 'boolean'
        : true;
  if (!valid) throw new ToolArgumentError(`Argument "${name}" must be a ${schema.type}.`);
  if (MESSAGE_ID_ARGUMENTS.has(name) && !NUMERIC_ID.test(value as string)) {
    throw new ToolArgumentError(`Argument "${name}" must be a numeric Discord message ID.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new ToolArgumentError(`Argument "${name}" must be one of: ${schema.enum.join(', ')}.`);
  }
}
export function validateToolArguments(definition: ToolDefinition, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolArgumentError('Tool arguments must be a JSON object.');
  }
  const args = { ...(value as Record<string, unknown>) };
  const { properties, required = [] } = definition.function.parameters;
  // Own-property checks only, so names such as "toString" or "__proto__" are never treated as known arguments.
  const has = (target: object, key: string) => Object.prototype.hasOwnProperty.call(target, key);
  for (const key of Object.keys(args)) {
    if (!has(properties, key)) throw new ToolArgumentError(`Unknown argument "${key}".`);
  }
  for (const key of required) {
    if (!has(args, key)) throw new ToolArgumentError(`Missing required argument "${key}".`);
  }
  for (const [key, current] of Object.entries(args)) {
    const schema = properties[key];
    const isBlankString = typeof current === 'string' && current.trim() === '';
    const absent =
      current === null ||
      current === undefined ||
      (isBlankString && !required.includes(key));
    if (absent && !required.includes(key)) {
      delete args[key];
    } else {
      const coerced = coerceKnownArgument(key, current, schema);
      args[key] = coerced;
      validateValue(key, coerced, schema);
    }
  }
  return args;
}
export function parseToolArguments(definition: ToolDefinition, raw: string): Record<string, unknown> {
  try {
    return validateToolArguments(definition, JSON.parse(raw || '{}'));
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    throw new ToolArgumentError('Tool arguments are malformed JSON.');
  }
}
