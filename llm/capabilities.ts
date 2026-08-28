/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ProviderCapabilities, ProviderPreset } from '../types';

const CONSERVATIVE: ProviderCapabilities = {
  strictSchemas: false, streamingTools: true, parallelToolCalls: false, developerMessages: false, vision: false,
};

const PRESETS: Record<ProviderPreset, ProviderCapabilities> = {
  openai: { strictSchemas: true, streamingTools: true, parallelToolCalls: true, developerMessages: true, vision: true },
  openrouter: { ...CONSERVATIVE, vision: true },
  groq: { ...CONSERVATIVE, parallelToolCalls: true },
  omlx: { ...CONSERVATIVE },
  ollama: { ...CONSERVATIVE },
  lmstudio: { ...CONSERVATIVE },
  custom: { ...CONSERVATIVE },
};

export const getProviderCapabilities = (preset: ProviderPreset | string): ProviderCapabilities =>
  ({ ...(PRESETS[preset as ProviderPreset] || CONSERVATIVE) });
