/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ToolDefinition } from '../types';
export class ToolArgumentError extends Error {
  name = 'ToolArgumentError';
}
/** Message IDs are interpolated into Discord REST paths, so they must be plain decimal snowflakes. */
const MESSAGE_ID_ARGUMENTS = new Set(['message_id', 'before_message_id']);
const NUMERIC_ID = /^\d{1,22}$/;
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
  const args = value as Record<string, unknown>;
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
    const absent = current === null || (current === '' && MESSAGE_ID_ARGUMENTS.has(key));
    if (absent && !required.includes(key)) delete args[key];
    else validateValue(key, current, properties[key]);
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
