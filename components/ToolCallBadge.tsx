/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';
import { AgentStep } from '../types';
import { CheckIcon, ChevronRightIcon, CloseIcon, toolIcon } from './icons';

/** Raw tool data can hold dozens of full Discord messages; the debug view shows at most this many characters. */
const RAW_LIMIT = 6000;

function quoted(value: unknown, max = 48): string {
  const text = String(value ?? '').trim();
  return text.length > max ? `"${text.slice(0, max - 1)}…"` : `"${text}"`;
}

/** A readable, human description of one tool step, in the past tense once it has finished. */
function describeStep(step: Pick<AgentStep, 'toolName' | 'toolArgs' | 'content'>, done: boolean): string {
  const args = step.toolArgs || {};
  const verb = (running: string, finished: string) => (done ? finished : running);
  switch (step.toolName) {
    case 'search_messages': {
      const terms = [args.query && quoted(args.query), args.pattern && `pattern ${quoted(args.pattern, 32)}`, args.has && `with ${args.has}`]
        .filter(Boolean).join(' ');
      return `${verb('Searching', 'Searched')} ${terms || 'messages'}`;
    }
    case 'fetch_recent_messages': return `${verb('Reading', 'Read')} recent messages`;
    case 'fetch_surrounding_messages': return `${verb('Reading', 'Read')} the surrounding conversation`;
    case 'get_message_details': return `${verb('Opening', 'Opened')} the selected message`;
    case 'list_channel_pins': return `${verb('Checking', 'Checked')} pinned messages`;
    case 'list_threads': return `${verb('Listing', 'Listed')} threads`;
    case 'inspect_image': return `${verb('Looking at', 'Looked at')} an image`;
    case 'transcribe_voice_message':
      return args.translate ? `${verb('Translating', 'Translated')} a voice message` : `${verb('Transcribing', 'Transcribed')} a voice message`;
    case 'list_available_channels': return `${verb('Listing', 'Listed')} channels in scope`;
    case 'get_current_context': return `${verb('Checking', 'Checked')} the current conversation`;
    default: return step.content || `${verb('Running', 'Ran')} ${step.toolName || 'a tool'}`;
  }
}

function rawJson(value: unknown): string {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
  return text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT)}\n… (${text.length - RAW_LIMIT} more characters)` : text;
}

interface ToolCallBadgeProps {
  step: AgentStep;
}

/** One tool step: a readable line that expands to the tool's own summary and, on request, its raw data. */
export const ToolCallBadge: React.FC<ToolCallBadgeProps> = ({ step }) => {
  const [expanded, setExpanded] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);
  const done = step.toolResult !== undefined || step.type === 'error';
  const failed = step.type === 'error' || step.toolResult?.ok === false;
  const summary: string = typeof step.toolResult?.summary === 'string' ? step.toolResult.summary : step.content || '';

  return (
    <div>
      <button className="vai-step-head" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        {toolIcon(step.toolName)}
        <span className="vai-step-label">{describeStep(step, done)}</span>
        {!done ? <span className="vai-spinner" aria-label="Running" />
          : failed ? <span className="vai-step-status vai-fail" aria-label="Failed"><CloseIcon size={14} /></span>
            : <span className="vai-step-status vai-ok" aria-label="Done"><CheckIcon size={14} /></span>}
      </button>
      {expanded && (
        <div className="vai-step-detail">
          <div>{summary || (done ? 'No details.' : 'Running…')}</div>
          {(step.toolArgs || step.toolResult !== undefined) && (
            <button className="vai-action" onClick={() => setShowRaw(!showRaw)} aria-expanded={showRaw}>
              {showRaw ? 'Hide raw data' : 'Show raw data'}
            </button>
          )}
          {showRaw && step.toolArgs && <pre>{rawJson(step.toolArgs)}</pre>}
          {showRaw && step.toolResult !== undefined && <pre>{rawJson(step.toolResult)}</pre>}
        </div>
      )}
    </div>
  );
};

/** Steps that represent tool use (the final 'answer' step is the reply itself). */
function toolStepsOf(steps: AgentStep[] | undefined): AgentStep[] {
  return (steps || []).filter((s) => s.type === 'tool_call' || s.type === 'tool_result' || s.type === 'error');
}

/** The collapsed one-line summary of a finished run's tool use, e.g. "Used 3 tools (1 failed)". */
function activitySummary(steps: AgentStep[]): string {
  const failed = steps.filter((s) => s.type === 'error' || s.toolResult?.ok === false).length;
  const base = `Used ${steps.length} tool${steps.length === 1 ? '' : 's'}`;
  return failed ? `${base} (${failed} failed)` : base;
}

interface AgentActivityProps {
  steps?: AgentStep[];
  streaming: boolean;
  hasText: boolean;
}

/**
 * The reply's working state, shown above the answer like other assistants do: "Thinking…", the step that is
 * running now, or a collapsed "Used N tools" line that expands to each step.
 */
export const AgentActivity: React.FC<AgentActivityProps> = ({ steps, streaming, hasText }) => {
  const [open, setOpen] = React.useState(false);
  const toolSteps = toolStepsOf(steps);

  if (!toolSteps.length) {
    if (!streaming || hasText) return null;
    return <div className="vai-activity"><span className="vai-thinking"><span className="vai-spinner" />Thinking…</span></div>;
  }

  const running = streaming ? toolSteps.find((s) => s.toolResult === undefined && s.type !== 'error') : undefined;
  const label = running
    ? `${describeStep(running, false)}…`
    : streaming && !hasText ? 'Writing the answer…' : activitySummary(toolSteps);

  return (
    <div className="vai-activity">
      <button className="vai-activity-toggle" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide steps' : 'Show steps'}>
        {streaming && (running || !hasText) ? <span className="vai-spinner" /> : <ChevronRightIcon size={14} className="vai-chevron" />}
        <span>{label}</span>
      </button>
      {open && (
        <div className="vai-steps">
          {toolSteps.map((step) => <ToolCallBadge key={step.id} step={step} />)}
        </div>
      )}
    </div>
  );
};
