/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** UI-Q07: Enter and Space activate a role="button" element, as they do a native button. */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/** UI-Q07: makes a clickable div reachable and operable from the keyboard; pass `expanded` for disclosure toggles. */
export function clickableProps(onActivate: () => void, expanded?: boolean) {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-expanded': expanded,
    onClick: onActivate,
    onKeyDown: (e: { key: string; preventDefault(): void }) => {
      if (!isActivationKey(e.key)) return;
      e.preventDefault();
      onActivate();
    },
  };
}

/** UI-Q07: the toggle shortcut as the user's platform names it. */
export function shortcutLabel(platform: string | undefined): string {
  return /mac|iphone|ipad/i.test(platform ?? '') ? 'Cmd+Shift+A' : 'Ctrl+Shift+A';
}
