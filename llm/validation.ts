/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ToolDefinition } from '../types';
export class ToolArgumentError extends Error {
  name = 'ToolArgumentError';
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
  for (const key of Object.keys(args)) {
    if (!(key in properties)) throw new ToolArgumentError(`Unknown argument "${key}".`);
  }
  for (const key of required) {
    if (!(key in args)) throw new ToolArgumentError(`Missing required argument "${key}".`);
  }
  for (const [key, current] of Object.entries(args)) {
    if (current === null && !required.includes(key)) delete args[key];
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
