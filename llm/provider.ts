/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fetchImageAsBase64 } from '../discord/messages';
import {
  CompletionRequest,
  CompletionResult,
  LLMMessage,
  PluginSettings,
  ToolDefinition,
} from '../types';
import { getProviderCapabilities } from './capabilities';
import { OpenAICompatibleTransport, TransportCallbacks } from './transport';

export type StreamCallbacks = TransportCallbacks;

export class OpenAICompatibleClient {
  private settings: PluginSettings;
  private transport: OpenAICompatibleTransport;

  constructor(settings: PluginSettings) {
    this.settings = settings;
    const capabilities = getProviderCapabilities(settings.providerPreset);
    this.transport = new OpenAICompatibleTransport(settings, capabilities);
    console.info('[VencordAI] provider_capabilities', { preset: settings.providerPreset, ...capabilities });
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
    this.transport.update(settings, getProviderCapabilities(settings.providerPreset));
  }

  complete(
    request: CompletionRequest,
    callbacks?: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    return this.transport.complete(request, callbacks, signal);
  }

  chatCompletion(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
    callbacks?: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    return this.complete({ messages, tools, toolChoice: tools?.length ? 'auto' : 'none' }, callbacks, signal);
  }

  async analyzeImage(imageUrl: string, question: string, signal?: AbortSignal): Promise<string> {
    const capabilities = getProviderCapabilities(this.settings.providerPreset);
    if (!capabilities.vision) throw new Error('The selected provider preset does not declare vision support.');
    let resolvedImageUrl = imageUrl;
    if (/^https:\/\//.test(imageUrl)) resolvedImageUrl = await fetchImageAsBase64(imageUrl);
    const result = await this.complete({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question || 'Describe the image.' },
          { type: 'image_url', image_url: { url: resolvedImageUrl } },
        ],
      }],
      toolChoice: 'none',
      maxTokens: Math.min(this.settings.maxTokens, 1000),
      stream: false,
    }, undefined, signal);
    return result.content || 'No image description returned.';
  }
}
