/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ChatErrorKind = 'unreachable' | 'auth' | 'model' | 'baseUrl';

export interface ChatErrorHint {
  kind: ChatErrorKind;
  /** A fixed sentence: never built from the error text, so it cannot echo a key or a credentialed URL. */
  hint: string;
}

const ERROR_PREFIX = '⚠️ **Error**:';

const HINTS: Record<ChatErrorKind, string> = {
  unreachable: "Can't reach the model server. Is it running, and is the Base URL correct?",
  auth: 'The server rejected the API key. Check the API Key setting.',
  model: 'The model was not found. Check Model Identifier against the server\'s model list.',
  baseUrl: 'The Base URL is invalid. It must be an http:// or https:// URL, such as http://localhost:8000/v1.',
};

/**
 * UI-Q02: recognises common provider failures in an assistant error reply (chatService writes
 * `⚠️ **Error**: <message>`) and returns a one-line fix hint, or null for other replies and unknown errors.
 */
export function classifyChatError(content: string | undefined): ChatErrorHint | null {
  if (!content?.startsWith(ERROR_PREFIX)) return null;
  const text = content.slice(ERROR_PREFIX.length);
  const kind: ChatErrorKind | null =
    /base url must|invalid url|failed to parse url/i.test(text) ? 'baseUrl'
      : /\((401|403)\)|HTTP (401|403)\b|unauthori[sz]ed|invalid api key|incorrect api key/i.test(text) ? 'auth'
        : /model identifier|model .*not found|could not (load|unload) the local model|\(404\)|HTTP 404\b/i.test(text) ? 'model'
          : /failed to fetch|fetch failed|networkerror|load failed|ECONNREFUSED|ERR_CONNECTION|ENOTFOUND|connection refused/i.test(text) ? 'unreachable'
            : null;
  return kind ? { kind, hint: HINTS[kind] } : null;
}
