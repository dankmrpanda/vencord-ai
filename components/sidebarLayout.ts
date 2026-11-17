/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The sidebar docks to the right like Discord's member list: while it is open, `body.vai-docked` narrows
 * #app-mount by `--vai-sidebar-width`, so Discord's own modals, menus and window controls stay usable instead
 * of opening underneath an overlay.
 */
export const DEFAULT_SIDEBAR_WIDTH = 400;
export const MIN_SIDEBAR_WIDTH = 320;
export const MAX_SIDEBAR_WIDTH = 720;
/** Discord itself needs room for the server list, channel list and a usable chat column. */
export const MIN_DISCORD_WIDTH = 560;
const WIDTH_KEY = 'vencord-ai-sidebar-width';

let currentWidth: number | null = null;

/** The width to use for a requested size: within the panel's limits and leaving Discord room on screen. */
export function clampSidebarWidth(requested: number, viewportWidth: number): number {
  const max = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, viewportWidth - MIN_DISCORD_WIDTH));
  const value = Number.isFinite(requested) ? Math.round(requested) : DEFAULT_SIDEBAR_WIDTH;
  return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, value));
}

function storage(): Storage | null {
  // Discord removes window.localStorage; treat any failure as "no persistence".
  try { return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null; } catch { return null; }
}

export function getSidebarWidth(): number {
  if (currentWidth === null) {
    let saved = NaN;
    try { saved = Number(storage()?.getItem(WIDTH_KEY)); } catch {}
    currentWidth = Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_SIDEBAR_WIDTH;
  }
  return currentWidth;
}

function applyWidth(width: number): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--vai-sidebar-width', `${width}px`);
}

/** Sets (and remembers) the width; returns the clamped value actually applied. */
export function setSidebarWidth(requested: number, persist = false): number {
  const width = clampSidebarWidth(requested, typeof window !== 'undefined' ? window.innerWidth : 1280);
  currentWidth = width;
  applyWidth(width);
  if (persist) {
    try { storage()?.setItem(WIDTH_KEY, String(width)); } catch {}
  }
  return width;
}

/** Docks (narrows Discord) while the panel is open, and undocks when it closes or the plugin stops. */
export function setSidebarDocked(docked: boolean): void {
  if (typeof document === 'undefined') return;
  if (docked) setSidebarWidth(getSidebarWidth());
  document.body.classList.toggle('vai-docked', docked);
  if (!docked) document.documentElement.style.removeProperty('--vai-sidebar-width');
}
