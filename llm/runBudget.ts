/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AgentRunBudget } from '../types';
export const DEFAULT_AGENT_RUN_BUDGET: AgentRunBudget = {
  maxModelTurns: 6,
  maxToolCalls: 12,
  maxElapsedMs: 90_000,
  maxReturnedRecords: 200,
  maxEstimatedInputTokens: 32_000,
  finalizationCalls: 1,
};
const normalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(normalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, current]) => [key, normalize(current)]))
    : value;
export class AgentBudgetTracker {
  readonly startedAt = Date.now();
  modelTurns = 0;
  toolCalls = 0;
  returnedRecords = 0;
  finalizationCalls = 0;
  estimatedInputTokens = 0;
  truncations = 0;
  private calls = new Set<string>();
  constructor(readonly limits: AgentRunBudget = DEFAULT_AGENT_RUN_BUDGET) {}
  canModelTurn = (): boolean => this.modelTurns < this.limits.maxModelTurns
    && this.estimatedInputTokens <= this.limits.maxEstimatedInputTokens && !this.expired();
  canToolCall = (): boolean => this.toolCalls < this.limits.maxToolCalls && !this.expired();
  expired = (): boolean => Date.now() - this.startedAt >= this.limits.maxElapsedMs;
  markCall(name: string, args: Record<string, unknown>): boolean {
    const key = `${name}:${JSON.stringify(normalize(args))}`;
    if (this.calls.has(key)) return false;
    this.calls.add(key);
    this.toolCalls++;
    return true;
  }
}
