import { React, useState } from '@webpack/common';
import { AgentStep } from '../types';

interface ToolCallBadgeProps {
  step: AgentStep;
}

export const ToolCallBadge: React.FC<ToolCallBadgeProps> = ({ step }) => {
  const [expanded, setExpanded] = useState(false);

  const getToolIcon = () => {
    switch (step.toolName) {
      case 'search_messages':
        return '🔍';
      case 'fetch_surrounding_messages':
      case 'fetch_recent_messages':
        return '📜';
      case 'inspect_image':
        return '🖼️';
      case 'list_available_channels':
      case 'get_current_context':
        return '🧭';
      default:
        return '⚡';
    }
  };

  const getStatusIcon = () => {
    if (step.type === 'error') return '❌';
    if (step.toolResult !== undefined) return '✅';
    return '⏳';
  };

  const getSummary = () => {
    if (step.toolName === 'search_messages') {
      const q = step.toolArgs?.query ? `"${step.toolArgs.query}"` : '';
      const h = step.toolArgs?.has ? ` [has:${step.toolArgs.has}]` : '';
      return `Search Discord ${q}${h}`.trim();
    }
    if (step.toolName === 'fetch_surrounding_messages') {
      return `Fetch context around message ${step.toolArgs?.message_id || ''}`.trim();
    }
    if (step.toolName === 'fetch_recent_messages') {
      return `Fetch recent channel messages`;
    }
    if (step.toolName === 'inspect_image') {
      return `Inspect image attachment`;
    }
    if (step.toolName === 'list_available_channels') {
      return `Discover available channel scopes`;
    }
    return step.content || `Executing ${step.toolName || 'tool'}`;
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle} onClick={() => setExpanded(!expanded)}>
        <span style={toolIconStyle}>{getToolIcon()}</span>
        <span style={summaryStyle}>{getSummary()}</span>
        <span style={statusIconStyle}>{getStatusIcon()}</span>
        <span style={toggleStyle}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={detailsStyle}>
          {step.toolArgs && (
            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>Arguments:</div>
              <pre style={codeBlockStyle}>{JSON.stringify(step.toolArgs, null, 2)}</pre>
            </div>
          )}
          {step.toolResult !== undefined && (
            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>Result:</div>
              <pre style={codeBlockStyle}>
                {typeof step.toolResult === 'string'
                  ? step.toolResult
                  : JSON.stringify(step.toolResult, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const containerStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-secondary-alt, #232428)',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  borderRadius: '6px',
  margin: '4px 0',
  fontSize: '11px',
  overflow: 'hidden',
  transition: 'border-color 0.15s ease',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '6px 10px',
  cursor: 'pointer',
  userSelect: 'none',
  gap: '6px',
};

const toolIconStyle: React.CSSProperties = {
  fontSize: '12px',
};

const statusIconStyle: React.CSSProperties = {
  fontSize: '10px',
  marginLeft: 'auto',
  marginRight: '4px',
};

const summaryStyle: React.CSSProperties = {
  flex: 1,
  fontWeight: 500,
  color: 'var(--text-muted, #949ba4)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const toggleStyle: React.CSSProperties = {
  fontSize: '8px',
  color: 'var(--text-muted, #949ba4)',
};

const detailsStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderTop: '1px solid var(--background-modifier-accent, #3f4147)',
  backgroundColor: 'var(--background-tertiary, #1e1f22)',
  maxHeight: '200px',
  overflowY: 'auto',
};

const sectionStyle: React.CSSProperties = {
  marginBottom: '6px',
};

const sectionTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '10px',
  color: 'var(--header-secondary, #b5bac1)',
  marginBottom: '3px',
  textTransform: 'uppercase',
};

const codeBlockStyle: React.CSSProperties = {
  margin: 0,
  padding: '6px 8px',
  backgroundColor: 'var(--background-floating, #111214)',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '10px',
  color: 'var(--text-normal, #dbdee1)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
};
