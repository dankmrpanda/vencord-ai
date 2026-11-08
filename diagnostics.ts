/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface DiagnosticLogEntry {
  time: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[Unserializable]';
  }
}

export function serializeLogArgument(value: unknown): string {
  try {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value !== 'object' || value === null) return safeString(value);
    return JSON.stringify(value) ?? safeString(value);
  } catch {
    return safeString(value);
  }
}

export function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

export function renderDiagnosticLogEntry(entry: DiagnosticLogEntry): string {
  const color = entry.level === 'error' ? '#f23f43' : entry.level === 'warn' ? '#f0b232' : '#949ba4';
  return `<div style="color: ${color}; margin-bottom: 3px;">[${escapeHtml(entry.time)}] ${escapeHtml(entry.message)}</div>`;
}
