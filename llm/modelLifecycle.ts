/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginSettings } from '../types';

export const MODEL_IDLE_TIMEOUT_MS = 60_000;

interface ModelEntry {
  settings: PluginSettings;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
  pending: Promise<void>;
  instanceId?: string;
}

/** Keeps a local model resident for the entire agent run, including tool calls. */
export class ModelLifecycle {
  private entries = new Map<string, ModelEntry>();

  constructor(private idleTimeoutMs = MODEL_IDLE_TIMEOUT_MS) {}

  async acquire(settings: PluginSettings): Promise<() => void> {
    if (!['omlx', 'ollama', 'lmstudio'].includes(settings.providerPreset)) return () => {};
    // Snapshot the endpoint and credentials so settings changes cannot unload another model.
    const snapshot = { ...settings, baseUrl: settings.baseUrl.replace(/\/+$/, '') };
    const key = JSON.stringify([snapshot.providerPreset, snapshot.baseUrl, snapshot.model, snapshot.apiKey]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { settings: snapshot, users: 0, pending: Promise.resolve() };
      this.entries.set(key, entry);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    const firstUser = entry.users++ === 0;
    const target = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--target.users > 0) return;
      target.timer = setTimeout(() => {
        target.timer = undefined;
        // Serialize unloading with the next load if a message arrives during eviction.
        target.pending = target.pending.catch(() => {}).then(async () => {
          if (target.users === 0) await this.changeResidency(target, false);
        }).catch(() => {
          console.warn('[VencordAI] Could not unload the idle local model. Check the model server.');
        }).finally(() => {
          if (target.users === 0 && !target.timer) this.entries.delete(key);
        });
      }, this.idleTimeoutMs);
    };
    if (firstUser) {
      target.pending = target.pending.catch(() => {}).then(() => this.changeResidency(target, true));
    }
    try {
      await target.pending;
      return release;
    } catch (error) {
      // Loading may have reached the server even if its response failed.
      release();
      throw error;
    }
  }

  private async changeResidency(entry: ModelEntry, load: boolean): Promise<void> {
    const { settings } = entry;
    const root = settings.baseUrl.replace(/\/v1$/, '');
    let url: string;
    let body: Record<string, unknown> = {};
    switch (settings.providerPreset) {
      case 'omlx':
        url = `${settings.baseUrl}/models/${encodeURIComponent(settings.model)}/${load ? 'load' : 'unload'}`;
        break;
      case 'ollama':
        url = `${root}/api/generate`;
        body = { model: settings.model, stream: false, keep_alive: load ? -1 : 0 };
        break;
      case 'lmstudio':
        if (!load && !entry.instanceId) return;
        url = `${root}/api/v1/models/${load ? 'load' : 'unload'}`;
        body = load ? { model: settings.model } : { instance_id: entry.instanceId };
        break;
      default:
        return;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`Could not ${load ? 'load' : 'unload'} the local model (HTTP ${response.status}). Check the model identifier and server's model-management API support.`);
    }
    if (settings.providerPreset === 'lmstudio' && load) {
      const result = await response.json();
      if (typeof result.instance_id !== 'string' || !result.instance_id) {
        throw new Error('LM Studio did not return a loaded model instance identifier.');
      }
      entry.instanceId = result.instance_id;
    }
  }
}

export const modelLifecycle = new ModelLifecycle();
