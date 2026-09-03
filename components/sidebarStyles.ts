/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from '@webpack/common';

export const panelContainerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  backgroundColor: 'var(--background-primary, #313338)',
  borderLeft: '1px solid var(--background-modifier-accent, #3f4147)',
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  userSelect: 'text',
};

export const panelHeaderStyle: React.CSSProperties = {
  height: '48px',
  padding: '0 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
  flexShrink: 0,
};

export const headerTitleGroupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

export const headerTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '14px',
  color: 'var(--header-primary, #f2f3f5)',
};

export const headerActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
};

export const iconButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: '6px',
  borderRadius: '4px',
  color: 'var(--interactive-normal, #b5bac1)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '14px',
  transition: 'background-color 0.15s ease, color 0.15s ease',
};

export const activeIconButtonStyle: React.CSSProperties = {
  ...iconButtonStyle,
  backgroundColor: 'var(--background-modifier-selected, rgba(255, 255, 255, 0.12))',
  color: 'var(--interactive-active, #ffffff)',
};

export const textButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--text-muted, #949ba4)',
  fontSize: '12px',
  cursor: 'pointer',
};

export const historyDrawerStyle: React.CSSProperties = {
  position: 'absolute',
  top: '48px',
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'var(--background-primary, #313338)',
  zIndex: 10,
  display: 'flex',
  flexDirection: 'column',
};

export const historyHeaderStyle: React.CSSProperties = {
  padding: '12px 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontWeight: 600,
  fontSize: '13px',
  color: 'var(--header-secondary, #b5bac1)',
  borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
};

export const emptyHistoryTextStyle: React.CSSProperties = {
  padding: '24px',
  textAlign: 'center',
  color: 'var(--text-muted, #949ba4)',
  fontSize: '12px',
};

export const historyListStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px',
};

export const historyItemStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: '6px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  marginBottom: '6px',
  cursor: 'pointer',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  border: '1px solid transparent',
  transition: 'border-color 0.15s ease',
};

export const activeHistoryItemStyle: React.CSSProperties = {
  ...historyItemStyle,
  borderColor: 'var(--brand-experiment, #5865f2)',
  backgroundColor: 'var(--background-secondary-alt, #232428)',
};

export const historyTitleStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--text-normal, #dbdee1)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '220px',
};

export const historyMetaStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted, #949ba4)',
  marginTop: '2px',
};

export const deleteButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--text-muted, #949ba4)',
  cursor: 'pointer',
  padding: '4px',
  fontSize: '12px',
};

export const messagesScrollContainerStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '14px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

export const emptyStateContainerStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  padding: '20px',
  color: 'var(--text-muted, #949ba4)',
};

export const emptyTitleStyle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: 'var(--header-primary, #f2f3f5)',
  marginBottom: '6px',
};

export const emptySubtitleStyle: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '1.4',
  maxWidth: '260px',
  marginBottom: '20px',
};

export const quickPromptsContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  width: '100%',
  maxWidth: '280px',
};

export const quickPromptButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  borderRadius: '6px',
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '12px',
  cursor: 'pointer',
  textAlign: 'left',
};

export const stopButtonContainerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  padding: '4px 0',
};

export const stopButtonStyle: React.CSSProperties = {
  padding: '4px 14px',
  backgroundColor: 'var(--button-danger-background, #da373c)',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
};

export const inputContainerStyle: React.CSSProperties = {
  position: 'relative',
  padding: '10px 12px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  borderTop: '1px solid var(--background-modifier-accent, #3f4147)',
  display: 'flex',
  gap: '8px',
  alignItems: 'flex-end',
  flexShrink: 0,
};

export const mentionPopupContainerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: '12px',
  right: '12px',
  marginBottom: '6px',
  backgroundColor: 'var(--background-secondary-alt, #1e1f22)',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  borderRadius: '8px',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
  overflow: 'hidden',
  zIndex: 1000,
  maxHeight: '220px',
  display: 'flex',
  flexDirection: 'column',
};

export const mentionPopupHeaderStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: '10px',
  fontWeight: 700,
  textTransform: 'uppercase',
  color: 'var(--text-muted, #949ba4)',
  backgroundColor: 'var(--background-tertiary, #111214)',
  borderBottom: '1px solid var(--background-modifier-accent, #3f4147)',
};

export const mentionListStyle: React.CSSProperties = {
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  padding: '4px',
  gap: '2px',
};

export const mentionItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '5px 8px',
  borderRadius: '4px',
  cursor: 'pointer',
  transition: 'background-color 0.1s ease',
};

export const mentionItemActiveStyle: React.CSSProperties = {
  ...mentionItemStyle,
  backgroundColor: 'var(--background-modifier-selected, rgba(255, 255, 255, 0.12))',
};

export const mentionAvatarPlaceholderStyle: React.CSSProperties = {
  width: '24px',
  height: '24px',
  borderRadius: '50%',
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '11px',
  fontWeight: 600,
  flexShrink: 0,
  overflow: 'hidden',
};

export const mentionGlobalNameStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--header-primary, #f2f3f5)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const mentionUsernameStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted, #949ba4)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const botTagStyle: React.CSSProperties = {
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#fff',
  fontSize: '8px',
  fontWeight: 700,
  padding: '1px 3px',
  borderRadius: '3px',
  lineHeight: '1',
};

export const textareaStyle: React.CSSProperties = {
  flex: 1,
  backgroundColor: 'var(--channeltextarea-background, #383a40)',
  border: 'none',
  borderRadius: '6px',
  padding: '8px 10px',
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '13px',
  lineHeight: '1.4',
  resize: 'none',
  fontFamily: 'inherit',
  outline: 'none',
  maxHeight: '120px',
};

export const sendButtonStyle: React.CSSProperties = {
  width: '34px',
  height: '34px',
  borderRadius: '6px',
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '16px',
  cursor: 'pointer',
  flexShrink: 0,
};

export const activeSendButtonStyle: React.CSSProperties = {
  ...sendButtonStyle,
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  color: '#fff',
};

export const disabledSendButtonStyle: React.CSSProperties = {
  ...sendButtonStyle,
  backgroundColor: 'var(--background-modifier-accent, #3f4147)',
  color: 'var(--text-muted, #949ba4)',
  cursor: 'not-allowed',
};

export const scopeEditButtonStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  borderRadius: '4px',
  color: 'var(--text-normal, #dbdee1)',
  padding: '2px 8px',
  fontSize: '11px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  marginLeft: 'auto',
  transition: 'background-color 0.15s ease',
};

export const scopeDropdownContainerStyle: React.CSSProperties = {
  marginTop: '8px',
  paddingTop: '8px',
  borderTop: '1px solid var(--background-modifier-accent, #3f4147)',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
};

export const scopeModeRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '6px',
  flexWrap: 'wrap',
};

export const scopeModePillStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: '4px',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  color: 'var(--text-muted, #949ba4)',
  fontSize: '11px',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};

export const scopeModeActivePillStyle: React.CSSProperties = {
  ...scopeModePillStyle,
  backgroundColor: 'var(--brand-experiment, #5865f2)',
  borderColor: 'var(--brand-experiment, #5865f2)',
  color: '#ffffff',
  fontWeight: 600,
};

export const scopeChannelListStyle: React.CSSProperties = {
  maxHeight: '140px',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
  padding: '4px',
  backgroundColor: 'var(--background-secondary, #2b2d31)',
  borderRadius: '4px',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
};

export const scopeChannelItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '3px 6px',
  borderRadius: '3px',
  fontSize: '11px',
  color: 'var(--text-normal, #dbdee1)',
  cursor: 'pointer',
  userSelect: 'none',
};

export const scopeSearchInputStyle: React.CSSProperties = {
  backgroundColor: 'var(--background-tertiary, #1e1f22)',
  border: '1px solid var(--background-modifier-accent, #3f4147)',
  borderRadius: '4px',
  padding: '4px 8px',
  color: 'var(--text-normal, #dbdee1)',
  fontSize: '11px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};
