/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AIAssistantAgent } from '../llm/agent';
import { modelLifecycle } from '../llm/modelLifecycle';
import {
  createNewSession,
  deleteSession as deleteSessionStorage,
  getSessionsForChannel,
  getSessionById,
  getStoredActiveSessionId,
  saveSession,
  setStoredActiveSessionId,
} from '../storage/chatHistory';
import {
  AgentStep,
  AssistantChatMessage,
  AssistantLaunchRequest,
  ChatSession,
  CitationItem,
  CurrentScopeContext,
  PluginSettings,
} from '../types';

export class ChatService {
  private activeSession: ChatSession | null = null;
  private generating = false;
  private abortController: AbortController | null = null;
  private listeners = new Set<() => void>();
  private settings: PluginSettings;

  constructor(initialSettings: PluginSettings) {
    this.settings = initialSettings;
  }

  updateSettings(newSettings: PluginSettings): void {
    this.settings = newSettings;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((fn) => {
      try { fn(); } catch (err) { console.error('[VencordAI] Listener error in ChatService:', err); }
    });
  }

  getActiveSession(): ChatSession | null {
    return this.activeSession;
  }

  isGenerating(): boolean {
    return this.generating;
  }

  async initSession(channelId?: string): Promise<ChatSession> {
    // If we already have an active session (especially while generating), maintain it
    if (this.activeSession) {
      return this.activeSession;
    }

    const targetChannel = channelId || 'global';
    const storedId = getStoredActiveSessionId();

    if (storedId) {
      try {
        const existing = await getSessionById(storedId);
        if (existing) {
          this.activeSession = existing;
          this.notify();
          return existing;
        }
      } catch {}
    }

    // Fall back to the most recent session for this channel
    try {
      const channelSessions = await getSessionsForChannel(targetChannel);
      if (channelSessions.length > 0) {
        this.activeSession = channelSessions[0];
        setStoredActiveSessionId(this.activeSession.id);
        this.notify();
        return this.activeSession;
      }
    } catch {}

    // Otherwise create a fresh session
    const fresh = createNewSession(targetChannel, 'New Conversation');
    this.activeSession = fresh;
    setStoredActiveSessionId(fresh.id);
    await saveSession(fresh);
    this.notify();
    return fresh;
  }

  switchSession(session: ChatSession): void {
    this.activeSession = session;
    setStoredActiveSessionId(session.id);
    this.notify();
  }

  newSession(channelId?: string): ChatSession {
    const targetChannel = channelId || this.activeSession?.channelId || 'global';
    const fresh = createNewSession(targetChannel, 'New Conversation');
    this.activeSession = fresh;
    setStoredActiveSessionId(fresh.id);
    saveSession(fresh).catch(() => {});
    this.notify();
    return fresh;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await deleteSessionStorage(sessionId);
    if (this.activeSession?.id === sessionId) {
      const channelId = this.activeSession.channelId || 'global';
      const remaining = await getSessionsForChannel(channelId);
      if (remaining.length > 0) {
        this.activeSession = remaining[0];
      } else {
        this.activeSession = createNewSession(channelId, 'New Conversation');
        await saveSession(this.activeSession);
      }
      setStoredActiveSessionId(this.activeSession.id);
    }
    this.notify();
  }

  stopGenerating(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.generating = false;
    this.notify();
  }

  async sendMessage(
    prompt: string,
    launchRequest?: AssistantLaunchRequest | null,
    customScope?: CurrentScopeContext | null,
  ): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed || this.generating) return;

    if (!this.activeSession) {
      await this.initSession();
    }

    const session = this.activeSession!;
    const turnId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const userMessage: AssistantChatMessage = {
      id: `usr_${turnId}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    };

    const assistantMsgId = `ast_${turnId}`;
    const assistantMessage: AssistantChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      steps: [],
      citations: [],
      timestamp: Date.now(),
      isStreaming: true,
    };

    session.messages.push(userMessage, assistantMessage);
    if (session.messages.length === 2 && session.title === 'New Conversation') {
      session.title = trimmed.slice(0, 32);
    }
    session.updatedAt = Date.now();

    // Persist immediately so accidental sidebar exit or refresh NEVER loses the user query
    await saveSession(session);

    this.generating = true;
    const controller = new AbortController();
    this.abortController = controller;
    this.notify();

    const updateAssistant = (updater: (msg: AssistantChatMessage) => void) => {
      const currentAssistant = session.messages.find((m) => m.id === assistantMsgId);
      if (currentAssistant) {
        updater(currentAssistant);
        this.notify();
      }
    };

    const runSettings = { ...this.settings };
    let releaseModel: (() => void) | undefined;
    try {
      releaseModel = await modelLifecycle.acquire(runSettings);
      controller.signal.throwIfAborted();
      const result = await new AIAssistantAgent(runSettings).run(
        trimmed,
        session.messages.slice(0, -2), // History before current turn
        {
          onToken: (token) => updateAssistant((m) => { m.content += token; }),
          onStepAdded: (step: AgentStep) => updateAssistant((m) => { m.steps = [...(m.steps || []), step]; }),
          onStepUpdated: (step: AgentStep) => updateAssistant((m) => {
            m.steps = (m.steps || []).map((s) => (s.id === step.id ? step : s));
          }),
          onCitationsUpdated: (citations: CitationItem[]) => updateAssistant((m) => { m.citations = citations; }),
        },
        controller.signal,
        launchRequest || undefined,
        customScope || undefined,
      );

      const finalMsg = session.messages.find((m) => m.id === assistantMsgId);
      if (finalMsg) {
        finalMsg.content = result.content;
        finalMsg.steps = result.steps;
        finalMsg.citations = result.citations;
        finalMsg.isStreaming = false;
      }
      session.updatedAt = Date.now();
      await saveSession(session);
    } catch (err: any) {
      const finalMsg = session.messages.find((m) => m.id === assistantMsgId);
      if (finalMsg) {
        if (!controller.signal.aborted && !String(err?.message || '').includes('Agent execution cancelled')) {
          finalMsg.content = `⚠️ **Error**: ${err.message || String(err)}`;
        }
        finalMsg.isStreaming = false;
      }
      session.updatedAt = Date.now();
      await saveSession(session);
    } finally {
      releaseModel?.();
      if (this.abortController === controller) {
        this.generating = false;
        this.abortController = null;
      }
      this.notify();
    }
  }
}

let globalChatService: ChatService | null = null;

export function getChatService(settings: PluginSettings): ChatService;
export function getChatService(): ChatService | null;
export function getChatService(settings?: PluginSettings): ChatService | null {
  if (!globalChatService && settings) {
    globalChatService = new ChatService(settings);
  }
  return globalChatService;
}
