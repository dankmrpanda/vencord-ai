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
  export const React: typeof import('react');
  export const ReactDOM: typeof import('react-dom');
  export const FluxDispatcher: any;
  export const NavigationRouter: any;
  export const RestAPI: any;
}
