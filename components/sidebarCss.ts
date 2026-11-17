/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The sidebar's stylesheet, injected once by index.tsx. Classes (not inline styles) so hover, focus and
 * disabled states work. Colours come from Discord's theme variables: the refreshed names first, then the
 * older ones, then dark-theme literals, so the panel follows the user's theme.
 */
export const SIDEBAR_CSS = `
:root { --vai-sidebar-width: 400px; }

body.vai-docked #app-mount {
  width: calc(100% - var(--vai-sidebar-width)) !important;
}

#vencord-ai-sidebar-root {
  --vai-bg: var(--background-base-lower, var(--background-secondary, #2b2d31));
  --vai-bg-raised: var(--background-surface-high, var(--background-primary, #313338));
  --vai-bg-floating: var(--background-surface-highest, var(--background-floating, #111214));
  --vai-bg-input: var(--channeltextarea-background, var(--background-tertiary, #383a40));
  --vai-bg-hover: var(--background-modifier-hover, rgba(78, 80, 88, 0.3));
  --vai-bg-active: var(--background-modifier-selected, rgba(78, 80, 88, 0.6));
  --vai-border: var(--border-subtle, var(--background-modifier-accent, rgba(78, 80, 88, 0.48)));
  --vai-text: var(--text-default, var(--text-normal, #dbdee1));
  --vai-text-strong: var(--text-strong, var(--header-primary, #f2f3f5));
  --vai-text-muted: var(--text-muted, #949ba4);
  --vai-icon: var(--interactive-normal, #b5bac1);
  --vai-icon-hover: var(--interactive-hover, #dbdee1);
  --vai-icon-active: var(--interactive-active, #ffffff);
  --vai-brand: var(--brand-500, var(--brand-experiment, #5865f2));
  --vai-brand-hover: var(--brand-560, var(--brand-experiment-560, #4752c4));
  --vai-danger: var(--status-danger, var(--text-danger, #f23f43));
  --vai-warning: var(--status-warning, var(--text-warning, #f0b232));
  --vai-positive: var(--status-positive, var(--text-positive, #23a55a));
  --vai-link: var(--text-link, #00a8fc);
  --vai-font: var(--font-primary, "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif);
  --vai-font-code: var(--font-code, "gg mono", Consolas, "Andale Mono WT", "Andale Mono", monospace);

  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--vai-sidebar-width);
  max-width: 100vw;
  z-index: 100;
  display: flex;
  flex-direction: column;
  background: var(--vai-bg);
  border-left: 1px solid var(--vai-border);
  color: var(--vai-text);
  font-family: var(--vai-font);
  font-size: 14px;
  line-height: 1.375;
  box-sizing: border-box;
  user-select: text;
}
#vencord-ai-sidebar-root *, #vencord-ai-sidebar-root *::before, #vencord-ai-sidebar-root *::after { box-sizing: border-box; }
#vencord-ai-sidebar-root button { font-family: inherit; }
#vencord-ai-sidebar-root ::-webkit-scrollbar { width: 8px; height: 8px; }
#vencord-ai-sidebar-root ::-webkit-scrollbar-track { background: transparent; }
#vencord-ai-sidebar-root ::-webkit-scrollbar-thumb { background: var(--scrollbar-thin-thumb, rgba(26, 27, 30, 0.9)); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }
#vencord-ai-sidebar-root :focus-visible { outline: 2px solid var(--focus-primary, var(--vai-brand)); outline-offset: 1px; }
#vencord-ai-sidebar-root textarea:focus-visible, #vencord-ai-sidebar-root input:focus-visible { outline: none; }

.vai-panel { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }

/* Resize handle on the left edge */
.vai-resize { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
.vai-resize:hover, .vai-resize.vai-active { background: var(--vai-brand); opacity: 0.6; }

/* Header: same height and weight as Discord's channel header */
.vai-header { height: 48px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--vai-border); box-shadow: var(--elevation-low, none); }
.vai-header-title { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; color: var(--vai-text-strong); font-weight: 600; font-size: 16px; }
.vai-header-title svg { color: var(--vai-brand); flex-shrink: 0; }
.vai-header-title span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-header-actions { display: flex; align-items: center; gap: 2px; }

.vai-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--vai-icon); cursor: pointer; transition: background-color 0.1s ease, color 0.1s ease; }
.vai-icon-btn:hover:not(:disabled) { background: var(--vai-bg-hover); color: var(--vai-icon-hover); }
.vai-icon-btn:active:not(:disabled), .vai-icon-btn[aria-pressed="true"] { background: var(--vai-bg-active); color: var(--vai-icon-active); }
.vai-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.vai-icon-btn.vai-small { width: 24px; height: 24px; border-radius: 4px; }

/* Message list */
.vai-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px 16px 8px; display: flex; flex-direction: column; gap: 12px; }
.vai-scroll-anchor { height: 1px; flex-shrink: 0; }

/* Empty state */
.vai-empty { margin: auto 0; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 24px 8px; }
.vai-empty-mark { width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--vai-brand); color: #fff; margin-bottom: 12px; }
.vai-empty h2 { margin: 0 0 4px; font-size: 20px; font-weight: 700; color: var(--vai-text-strong); line-height: 1.25; }
.vai-empty p { margin: 0 0 20px; font-size: 14px; color: var(--vai-text-muted); max-width: 300px; }
.vai-suggestions { display: grid; gap: 8px; width: 100%; max-width: 340px; }
.vai-suggestion { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border: 1px solid var(--vai-border); border-radius: 8px; background: var(--vai-bg-raised); color: var(--vai-text); font-size: 14px; text-align: left; cursor: pointer; transition: background-color 0.1s ease, border-color 0.1s ease; }
.vai-suggestion:hover { background: var(--vai-bg-hover); border-color: transparent; }
.vai-suggestion svg { color: var(--vai-icon); flex-shrink: 0; }

/* Messages */
.vai-msg { position: relative; display: flex; flex-direction: column; min-width: 0; }
.vai-msg-user { align-items: flex-end; }
.vai-bubble { max-width: 88%; padding: 8px 12px; border-radius: 16px 16px 4px 16px; background: var(--vai-bg-raised); color: var(--vai-text); white-space: pre-wrap; word-break: break-word; }
.vai-msg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.vai-avatar { width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--vai-brand); color: #fff; }
.vai-msg-name { font-weight: 600; font-size: 14px; color: var(--vai-text-strong); }
.vai-time { font-size: 12px; color: var(--vai-text-muted); }
.vai-msg-body { padding-left: 32px; min-width: 0; }
.vai-content { color: var(--vai-text); word-break: break-word; }
.vai-content p { margin: 0 0 6px; }
.vai-content p:last-child { margin-bottom: 0; }
.vai-content h2, .vai-content h3, .vai-content h4 { margin: 10px 0 4px; color: var(--vai-text-strong); line-height: 1.25; }
.vai-content h2 { font-size: 18px; } .vai-content h3 { font-size: 16px; } .vai-content h4 { font-size: 14px; }
.vai-content strong { color: var(--vai-text-strong); font-weight: 700; }
.vai-content blockquote { margin: 4px 0; padding: 0 0 0 12px; border-left: 4px solid var(--vai-border); color: var(--vai-text); }
.vai-content ul, .vai-content ol { margin: 4px 0 6px; padding-left: 20px; }
.vai-content li { margin: 2px 0; }
.vai-content hr { border: 0; border-top: 1px solid var(--vai-border); margin: 10px 0; }
.vai-content a { color: var(--vai-link); text-decoration: none; cursor: pointer; }
.vai-content a:hover { text-decoration: underline; }
.vai-link-url { color: var(--vai-text-muted); word-break: break-all; }
.vai-content code { font-family: var(--vai-font-code); font-size: 0.85em; padding: 0.1em 0.35em; border-radius: 4px; background: var(--vai-bg-raised); border: 1px solid var(--vai-border); }
.vai-codeblock { margin: 6px 0; border: 1px solid var(--vai-border); border-radius: 6px; background: var(--vai-bg-floating); overflow: hidden; }
.vai-codeblock-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 2px 10px; font-size: 12px; color: var(--vai-text-muted); border-bottom: 1px solid var(--vai-border); }
.vai-codeblock pre { margin: 0; padding: 8px 10px; overflow-x: auto; font-family: var(--vai-font-code); font-size: 13px; line-height: 1.4; color: var(--vai-text); }
.vai-codeblock pre code { padding: 0; background: none; font-size: inherit; }
.vai-cursor { display: inline-block; width: 8px; height: 1em; margin-left: 2px; vertical-align: text-bottom; border-radius: 1px; background: var(--vai-text-muted); animation: vai-blink 1s steps(1) infinite; }
.vai-note { color: var(--vai-text-muted); font-style: italic; }
@keyframes vai-blink { 50% { opacity: 0; } }

/* Hover actions under an answer */
.vai-actions { display: flex; gap: 2px; margin: 2px 0 -4px -6px; opacity: 0; transition: opacity 0.1s ease; }
.vai-msg:hover .vai-actions, .vai-msg:focus-within .vai-actions, .vai-actions.vai-visible { opacity: 1; }
.vai-action { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; border: 0; border-radius: 4px; background: transparent; color: var(--vai-icon); font-size: 12px; cursor: pointer; }
.vai-action:hover { background: var(--vai-bg-hover); color: var(--vai-icon-hover); }

/* Error hint */
.vai-error-hint { display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--vai-border); background: var(--vai-bg-raised); font-size: 13px; }
.vai-error-hint svg { color: var(--vai-warning); flex-shrink: 0; margin-top: 1px; }
.vai-error-text { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; color: var(--vai-text-muted); word-break: break-word; }
.vai-error-title { color: var(--vai-text-strong); font-weight: 500; }
.vai-action.vai-outline { margin-top: 2px; border: 1px solid var(--vai-border); color: var(--vai-text); }

/* Agent activity (tool calls) */
.vai-activity { margin-bottom: 6px; }
.vai-activity-toggle { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 6px 2px 2px; border: 0; border-radius: 4px; background: transparent; color: var(--vai-text-muted); font-size: 13px; cursor: pointer; }
.vai-activity-toggle:hover { color: var(--vai-text); }
.vai-activity-toggle span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-activity-toggle svg { flex-shrink: 0; transition: transform 0.15s ease; }
.vai-activity-toggle[aria-expanded="true"] .vai-chevron { transform: rotate(90deg); }
.vai-steps { margin: 4px 0 2px 7px; padding-left: 12px; border-left: 2px solid var(--vai-border); display: flex; flex-direction: column; gap: 2px; }
.vai-step-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 4px; border: 0; border-radius: 4px; background: transparent; color: var(--vai-text-muted); font-size: 13px; text-align: left; cursor: pointer; }
.vai-step-head:hover { background: var(--vai-bg-hover); color: var(--vai-text); }
.vai-step-head svg { flex-shrink: 0; }
.vai-step-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-step-status { flex-shrink: 0; font-size: 12px; }
.vai-step-status.vai-ok { color: var(--vai-positive); }
.vai-step-status.vai-fail { color: var(--vai-danger); }
.vai-step-detail { margin: 2px 0 6px 24px; font-size: 12px; color: var(--vai-text-muted); }
.vai-step-detail pre { margin: 4px 0 0; max-height: 220px; overflow: auto; padding: 6px 8px; border-radius: 4px; background: var(--vai-bg-floating); font-family: var(--vai-font-code); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vai-text); }
.vai-spinner { width: 12px; height: 12px; flex-shrink: 0; border-radius: 50%; border: 2px solid var(--vai-border); border-top-color: var(--vai-brand); animation: vai-spin 0.8s linear infinite; }
@keyframes vai-spin { to { transform: rotate(360deg); } }
.vai-thinking { display: inline-flex; align-items: center; gap: 8px; color: var(--vai-text-muted); font-size: 13px; }

/* Sources */
.vai-sources { margin-top: 8px; }
.vai-sources-toggle { display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px 0 4px; border: 1px solid var(--vai-border); border-radius: 14px; background: var(--vai-bg-raised); color: var(--vai-text); font-size: 13px; cursor: pointer; }
.vai-sources-toggle:hover { background: var(--vai-bg-hover); }
.vai-faces { display: inline-flex; }
.vai-faces img, .vai-faces .vai-face { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--vai-bg-raised); margin-left: -6px; object-fit: cover; background: var(--vai-brand); color: #fff; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.vai-faces > :first-child { margin-left: 0; }
.vai-source-list { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.vai-source { display: flex; gap: 10px; padding: 8px; border-radius: 8px; border: 1px solid var(--vai-border); background: var(--vai-bg-raised); cursor: pointer; text-align: left; color: var(--vai-text); font-size: 13px; width: 100%; }
.vai-source:hover { background: var(--vai-bg-hover); }
.vai-source-avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; object-fit: cover; background: var(--vai-brand); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; }
.vai-source-main { flex: 1; min-width: 0; }
.vai-source-meta { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.vai-source-author { font-weight: 600; color: var(--vai-text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-source-where { font-size: 12px; color: var(--vai-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-source-jump { margin-left: auto; color: var(--vai-icon); flex-shrink: 0; display: inline-flex; opacity: 0; }
.vai-source:hover .vai-source-jump, .vai-source:focus-visible .vai-source-jump { opacity: 1; }
.vai-source-text { margin-top: 2px; color: var(--vai-text); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: break-word; }
.vai-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.vai-thumb { max-width: 120px; max-height: 90px; border-radius: 4px; object-fit: cover; cursor: zoom-in; border: 1px solid var(--vai-border); }
.vai-file-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 200px; padding: 2px 8px; border: 1px solid var(--vai-border); border-radius: 4px; background: var(--vai-bg-floating); color: var(--vai-text); font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Jump to latest */
.vai-jump-latest { position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%); display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: 0; border-radius: 14px; background: var(--vai-brand); color: #fff; font-size: 13px; font-weight: 500; cursor: pointer; box-shadow: var(--elevation-high, 0 8px 16px rgba(0, 0, 0, 0.24)); z-index: 3; }
.vai-jump-latest:hover { background: var(--vai-brand-hover); }

/* Composer */
.vai-composer-wrap { position: relative; flex-shrink: 0; padding: 0 16px 16px; }
.vai-composer { border-radius: 8px; background: var(--vai-bg-input); border: 1px solid transparent; transition: border-color 0.1s ease; }
.vai-composer:focus-within { border-color: var(--vai-border); }
.vai-attached { display: flex; align-items: center; gap: 6px; margin: 8px 8px 0; padding: 4px 4px 4px 8px; border-radius: 6px; background: var(--vai-bg-floating); font-size: 12px; color: var(--vai-text-muted); }
.vai-attached span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-attached strong { color: var(--vai-text); font-weight: 600; }
.vai-textarea { display: block; width: 100%; min-height: 44px; max-height: 200px; padding: 11px 12px 4px; border: 0; background: transparent; color: var(--vai-text); font: inherit; font-size: 14px; line-height: 1.375; resize: none; outline: none; }
.vai-textarea::placeholder { color: var(--text-placeholder, var(--vai-text-muted)); }
.vai-composer-foot { display: flex; align-items: center; gap: 8px; padding: 4px 6px 6px 8px; }
.vai-composer-hint { margin-left: auto; font-size: 11px; color: var(--vai-text-muted); white-space: nowrap; }
.vai-send { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0; border: 0; border-radius: 50%; background: var(--vai-brand); color: #fff; cursor: pointer; transition: background-color 0.1s ease, opacity 0.1s ease; }
.vai-send:hover:not(:disabled) { background: var(--vai-brand-hover); }
.vai-send:disabled { opacity: 0.35; cursor: not-allowed; }
.vai-send.vai-stop { background: var(--vai-text-strong); color: var(--vai-bg); }
.vai-disclaimer { margin-top: 6px; text-align: center; font-size: 11px; color: var(--vai-text-muted); }

/* Scope chip and popover */
.vai-scope { position: relative; min-width: 0; }
.vai-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 26px; padding: 0 6px 0 8px; border: 1px solid var(--vai-border); border-radius: 13px; background: transparent; color: var(--vai-text); font-size: 12px; font-weight: 500; cursor: pointer; }
.vai-chip:hover { background: var(--vai-bg-hover); }
.vai-chip span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-chip svg { flex-shrink: 0; color: var(--vai-icon); }
.vai-popover { position: absolute; left: 0; bottom: calc(100% + 8px); width: 280px; max-width: calc(var(--vai-sidebar-width) - 40px); padding: 8px; border-radius: 8px; background: var(--vai-bg-floating); border: 1px solid var(--vai-border); box-shadow: var(--elevation-high, 0 8px 16px rgba(0, 0, 0, 0.24)); z-index: 20; }
.vai-popover-title { padding: 4px 8px 6px; font-size: 12px; font-weight: 600; color: var(--vai-text-muted); text-transform: uppercase; letter-spacing: 0.02em; }
.vai-option { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 8px; border: 0; border-radius: 4px; background: transparent; color: var(--vai-text); text-align: left; cursor: pointer; font-size: 14px; }
.vai-option:hover { background: var(--vai-bg-hover); }
.vai-option[aria-checked="true"] { background: var(--vai-bg-active); color: var(--vai-text-strong); }
.vai-option svg { flex-shrink: 0; margin-top: 1px; color: var(--vai-icon); }
.vai-option small { display: block; font-size: 12px; color: var(--vai-text-muted); }
.vai-channel-filter { width: 100%; margin: 6px 0 4px; padding: 6px 8px; border: 0; border-radius: 4px; background: var(--vai-bg-input); color: var(--vai-text); font: inherit; font-size: 13px; outline: none; }
.vai-channel-list { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; }
.vai-channel { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; font-size: 13px; color: var(--vai-text); cursor: pointer; user-select: none; }
.vai-channel:hover { background: var(--vai-bg-hover); }
.vai-channel input { margin: 0; accent-color: var(--vai-brand); }
.vai-muted { color: var(--vai-text-muted); font-size: 12px; padding: 6px 8px; }

/* Mention autocomplete, shaped like Discord's */
.vai-mentions { position: absolute; left: 16px; right: 16px; bottom: calc(100% - 8px); max-height: 240px; display: flex; flex-direction: column; border-radius: 8px; background: var(--vai-bg-floating); border: 1px solid var(--vai-border); box-shadow: var(--elevation-high, 0 8px 16px rgba(0, 0, 0, 0.24)); overflow: hidden; z-index: 20; }
.vai-mentions-title { padding: 8px 12px 4px; font-size: 12px; font-weight: 600; color: var(--vai-text-muted); text-transform: uppercase; }
.vai-mentions-list { overflow-y: auto; padding: 4px; }
.vai-mention { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; }
.vai-mention[aria-selected="true"] { background: var(--vai-bg-active); }
.vai-mention img, .vai-mention .vai-face { width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0; background: var(--vai-brand); color: #fff; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.vai-mention-name { font-size: 14px; font-weight: 500; color: var(--vai-text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-mention-user { font-size: 12px; color: var(--vai-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-bot-tag { padding: 0 4px; border-radius: 3px; background: var(--vai-brand); color: #fff; font-size: 10px; font-weight: 600; line-height: 15px; }

/* Drawers (history, diagnostics) slide over the message list */
.vai-drawer { position: absolute; top: 48px; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; background: var(--vai-bg); z-index: 10; animation: vai-fade 0.12s ease-out; }
@keyframes vai-fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.vai-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 8px 8px 16px; }
.vai-drawer-title { font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--vai-text-muted); letter-spacing: 0.02em; }
.vai-drawer-body { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
.vai-drawer-empty { padding: 32px 16px; text-align: center; color: var(--vai-text-muted); font-size: 14px; }
.vai-history-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 8px 8px 12px; border: 0; border-radius: 4px; background: transparent; color: var(--vai-text); text-align: left; cursor: pointer; }
.vai-history-item:hover:not([aria-disabled="true"]) { background: var(--vai-bg-hover); }
.vai-history-item[aria-current="true"] { background: var(--vai-bg-active); color: var(--vai-text-strong); }
.vai-history-item[aria-disabled="true"] { opacity: 0.6; cursor: not-allowed; }
.vai-history-text { flex: 1; min-width: 0; }
.vai-history-title { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vai-history-meta { font-size: 12px; color: var(--vai-text-muted); }
.vai-history-delete { opacity: 0; }
.vai-history-item:hover .vai-history-delete, .vai-history-item:focus-within .vai-history-delete, .vai-history-delete.vai-armed { opacity: 1; }
.vai-history-delete.vai-armed { width: auto; padding: 0 8px; color: var(--vai-danger); font-size: 12px; font-weight: 600; }
.vai-debug-facts { margin: 0 8px 8px; padding: 8px 10px; border-radius: 8px; background: var(--vai-bg-raised); font-size: 12px; color: var(--vai-text-muted); display: grid; gap: 2px; }
.vai-debug-facts strong { color: var(--vai-text); font-weight: 600; }
.vai-log { padding: 4px 8px; border-radius: 4px; font-family: var(--vai-font-code); font-size: 11px; word-break: break-word; color: var(--vai-text); }
.vai-log:nth-child(odd) { background: var(--vai-bg-raised); }
.vai-log.vai-warn { color: var(--vai-warning); }
.vai-log.vai-error { color: var(--vai-danger); }
.vai-log time { color: var(--vai-text-muted); margin-right: 6px; }
`;
