/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

declare module '@api/Settings' {
  export function definePluginSettings<T extends Record<string, any>>(options: T): {
    options: T;
    store: { [K in keyof T]: T[K]['default'] extends infer D ? (D extends undefined ? any : D) : any };
    useSettingsState(): { [K in keyof T]: T[K]['default'] extends infer D ? (D extends undefined ? any : D) : any };
  };
}

declare module '@utils/types' {
  export interface PluginAuthor {
    name: string;
    id?: bigint | string;
  }
  export interface PluginDefinition {
    name: string;
    description: string;
    authors: PluginAuthor[];
    settings?: any;
    options?: Record<string, any>;
    settingsAboutComponent?: React.ComponentType<any>;
    start?: () => void;
    stop?: () => void;
    patches?: any[];
    [key: string]: any;
  }
  export default function definePlugin<T extends PluginDefinition>(plugin: T): T;
  export enum OptionType {
    STRING = 0,
    NUMBER = 1,
    BOOLEAN = 2,
    SELECT = 3,
    COLOR = 4,
    COMPONENT = 5,
    SLIDER = 6,
  }
}

declare module '@utils/constants' {
  export const Devs: Record<string, { name: string; id?: bigint | string }>;
}

declare module '@webpack' {
  export function find(filter: (mod: any) => boolean): any;
  export function findByProps(...props: string[]): any;
  export function findStore(name: string): any;
  export function findByPropsLazy(...props: string[]): any;
  export function findByCode(...code: string[]): any;
}

declare module '@webpack/common' {
  import * as ReactTypes from 'react';
  export const React: typeof ReactTypes;
  export const useState: typeof ReactTypes.useState;
  export const useEffect: typeof ReactTypes.useEffect;
  export const useRef: typeof ReactTypes.useRef;
  export const useMemo: typeof ReactTypes.useMemo;
  export const useCallback: typeof ReactTypes.useCallback;
  export const createContext: typeof ReactTypes.createContext;
  export const useContext: typeof ReactTypes.useContext;

  export const ReactDOM: {
    createRoot?: (container: Element | DocumentFragment) => {
      render(children: ReactTypes.ReactNode): void;
      unmount(): void;
    };
    render?: (element: ReactTypes.ReactNode, container: Element | null) => any;
    unmountComponentAtNode?: (container: Element) => boolean;
  };
  export const FluxDispatcher: any;
  export const NavigationRouter: any;
  export const RestAPI: any;
}
