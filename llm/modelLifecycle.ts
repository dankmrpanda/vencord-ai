/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginSettings } from '../types';

export const MODEL_IDLE_TIMEOUT_MS = 5 * 60_000;
const UNLOAD_RETRY_MS = 30_000;

interface ModelEntry {
  settings: PluginSettings;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
  pending: Promise<void>;
  instanceId?: string;
  loaded: boolean;
  needsCleanup: boolean;
  loading: boolean;
  loadPending?: Promise<void>;
  unloading?: Promise<void>;
}

/** Cancel a caller's wait without cancelling a load shared by other callers. */
async function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Keeps a local model resident for the entire agent run, including tool calls. */
export class ModelLifecycle {
  private entries = new Map<string, ModelEntry>();
  private stopped = false;
  private shutdownController = new AbortController();
  private shutdownPromise: Promise<void> = Promise.resolve();

  constructor(private idleTimeoutMs = MODEL_IDLE_TIMEOUT_MS) {}

  get signal(): AbortSignal {
    return this.shutdownController.signal;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.shutdownController = new AbortController();
    void this.shutdownPromise.then(() => {
      if (this.stopped) return;
      for (const [key, entry] of this.entries) {
        if (entry.users === 0 && entry.needsCleanup) this.scheduleUnload(key, entry, UNLOAD_RETRY_MS);
      }
    });
  }

  async acquire(settings: PluginSettings, signal?: AbortSignal): Promise<() => void> {
    if (this.stopped) throw new Error('The AI assistant is shutting down.');
    const lifecycleSignal = this.shutdownController.signal;
    const waitSignal = signal ? AbortSignal.any([signal, lifecycleSignal]) : lifecycleSignal;
    await waitFor(this.shutdownPromise, waitSignal);
    if (!['omlx', 'ollama', 'lmstudio'].includes(settings.providerPreset)) return () => {};
    // Snapshot the endpoint and credentials so settings changes cannot unload another model.
    const snapshot = { ...settings, baseUrl: settings.baseUrl.trim().replace(/\/+$/, '') };
    const key = JSON.stringify([snapshot.providerPreset, snapshot.baseUrl, snapshot.model, snapshot.apiKey]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        settings: snapshot, users: 0, pending: Promise.resolve(),
        loaded: false, needsCleanup: false, loading: false,
      };
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
      if (this.stopped || !target.needsCleanup) {
        this.forgetIfClean(key, target);
        return;
      }
      this.scheduleUnload(key, target, this.idleTimeoutMs);
    };
    if ((firstUser || !target.loaded) && !target.loadPending) {
      const loadPending = target.pending.catch(() => {}).then(async () => {
        lifecycleSignal.throwIfAborted();
        if (target.users === 0) return;
        if (target.loaded) return;
        target.loading = true;
        // A server can complete loading even if the client loses the response.
        target.needsCleanup = true;
        try {
          await this.changeResidency(target, true);
          target.loaded = true;
        } finally {
          target.loading = false;
        }
      });
      target.pending = loadPending;
      target.loadPending = loadPending;
      void loadPending.finally(() => {
        if (target.loadPending === loadPending) target.loadPending = undefined;
      }).catch(() => {});
    }
    try {
      await waitFor(target.pending, waitSignal);
      return release;
    } catch (error) {
      // Loading may have reached the server even if its response failed.
      release();
      throw error;
    }
  }

  /** Called on plugin disable and page exit. keepalive dispatches before the page disappears. */
  shutdown(keepalive = false): Promise<void> {
    if (this.stopped) return this.shutdownPromise;
    this.stopped = true;
    this.shutdownController.abort();
    const cleanups: Promise<void>[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      if (keepalive && (entry.unloading || (entry.loading && entry.settings.providerPreset !== 'lmstudio'))) {
        // Do not wait for a slow load before making a best-effort exit request.
        // Follow it with a serialized unload if the renderer is still alive.
        cleanups.push(this.changeResidency(entry, false, true).catch(() => {}));
      }
      cleanups.push(this.unload(key, entry, keepalive, true));
    }
    this.shutdownPromise = Promise.all(cleanups).then(() => {});
    return this.shutdownPromise;
  }

  private forgetIfClean(key: string, entry: ModelEntry): void {
    if (!entry.needsCleanup && entry.users === 0 && this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
  }

  private scheduleUnload(key: string, entry: ModelEntry, delay: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.unload(key, entry);
    }, delay);
  }

  private unload(key: string, entry: ModelEntry, keepalive = false, force = false): Promise<void> {
    if (entry.unloading) {
      // A queued idle eviction may skip a model acquired just before shutdown.
      return force ? entry.unloading.then(() => this.unload(key, entry, keepalive, true)) : entry.unloading;
    }
    const evict = async () => {
      if (!force && entry.users > 0) return;
      if (entry.needsCleanup) {
        await this.changeResidency(entry, false, keepalive);
        entry.loaded = false;
        entry.needsCleanup = false;
        entry.instanceId = undefined;
      }
    };
    // A warm model can be unloaded synchronously on exit; pending loads must finish first.
    const pending = keepalive && !entry.loading
      ? evict()
      : entry.pending.catch(() => {}).then(evict);
    entry.unloading = pending.catch(() => {
      console.warn('[VencordAI] Could not unload the local model. Check the model server.');
      // Keep the target so a temporary server failure cannot orphan a resident model.
      if (!this.stopped && entry.users === 0) this.scheduleUnload(key, entry, UNLOAD_RETRY_MS);
    }).finally(() => {
      entry.unloading = undefined;
      this.forgetIfClean(key, entry);
    });
    entry.pending = entry.unloading;
    return entry.unloading;
  }

  private async changeResidency(entry: ModelEntry, load: boolean, keepalive = false): Promise<void> {
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
        body = { model: settings.model, stream: false, keep_alive: load ? Math.ceil(this.idleTimeoutMs / 1000) : 0 };
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
      keepalive,
      signal: AbortSignal.timeout(load ? 120_000 : 10_000),
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
