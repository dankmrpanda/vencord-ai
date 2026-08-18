/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function findByProps(..._props: string[]): any {
  return null;
}

export function findStore(_name: string): any {
  return null;
}

export function findByPropsLazy(..._props: string[]): any {
  return () => null;
}

export function find(..._args: any[]): any {
  return null;
}

export function definePluginSettings<T extends Record<string, any>>(options: T) {
  const store: Record<string, any> = {};
  for (const key in options) {
    store[key] = options[key]?.default;
  }
  return {
    options,
    store,
    useSettingsState: () => store,
  };
}

export default function definePlugin<T>(plugin: T): T {
  return plugin;
}

export enum OptionType {
  STRING = 0,
  NUMBER = 1,
  BOOLEAN = 2,
  SELECT = 3,
  COLOR = 4,
  COMPONENT = 5,
  SLIDER = 6,
}

export const Devs: Record<string, { name: string; id?: bigint | string }> = {};

export const React = (typeof window !== 'undefined' && (window as any).React) || {
  createElement: () => null,
  useState: (init: any) => [init, () => {}],
  useEffect: () => {},
  useRef: (init: any) => ({ current: init }),
  useMemo: (fn: any) => fn(),
  useCallback: (fn: any) => fn,
  Component: class {},
};

export const ReactDOM = (typeof window !== 'undefined' && (window as any).ReactDOM) || {
  createRoot: () => ({ render: () => {}, unmount: () => {} }),
  render: () => {},
  unmountComponentAtNode: () => true,
};

export const createRoot = ReactDOM.createRoot;
