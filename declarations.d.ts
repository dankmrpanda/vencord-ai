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
    start?: () => void;
    stop?: () => void;
    patches?: any[];
    [key: string]: any;
  }
  export default function definePlugin<T extends PluginDefinition>(plugin: T): T;
}

declare module '@utils/constants' {
  export const Devs: Record<string, { name: string; id?: bigint | string }>;
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
