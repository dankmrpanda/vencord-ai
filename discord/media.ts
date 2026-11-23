/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordAttachment, DiscordMessage } from '../types';

export const DISCORD_CDN_RE = /^https:\/\/(?:cdn|media)\.discord(?:app)?\.(?:com|net)\//i;
export const DISCORD_CDN_ATTACHMENTS_RE = /^https:\/\/(?:cdn|media)\.discord(?:app)?\.(?:com|net)\/attachments\//i;
export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#].*)?$/i;

export function isImageAttachment(attachment: Pick<DiscordAttachment, 'content_type' | 'filename' | 'url'>): boolean {
  return Boolean(attachment.content_type?.startsWith('image/')) || IMAGE_EXT_RE.test(attachment.filename || attachment.url || '');
}

export function extractMessageImageUrls(message: DiscordMessage | null | undefined): string[] {
  if (!message) return [];
  const urls: string[] = [];
  for (const a of message.attachments || []) {
    if (!a?.url || !DISCORD_CDN_RE.test(a.url)) continue;
    if (isImageAttachment(a)) urls.push(a.url);
  }
  for (const e of message.embeds || []) {
    const candidate = e?.image?.proxy_url || e?.image?.url || e?.thumbnail?.proxy_url || e?.thumbnail?.url;
    if (candidate && DISCORD_CDN_RE.test(candidate)) urls.push(candidate);
  }
  return Array.from(new Set(urls));
}

export function hasInspectableDiscordImage(message: DiscordMessage | null | undefined): boolean {
  return extractMessageImageUrls(message).length > 0;
}

function detectImageMimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Normalizes an image Blob into a clean JPEG/PNG data URL safe for local VLMs (e.g. oMLX / mlx-vlm).
 * In browser environments, decodes via Image/canvas and caps dimensions at 1536px to avoid AVIF/octet-stream
 * or oversized 4K PNG rejections; in headless/Node environments, inspects magic bytes to ensure a valid MIME type.
 */
export async function normalizeImageBlobToDataUrl(blob: Blob, maxDimension = 1536): Promise<string> {
  if (blob.size > 10 * 1024 * 1024) {
    throw new Error('Image exceeds the 10 MB inspection limit.');
  }

  // Browser / Electron canvas normalization: guarantees real JPEG/PNG encoding and bounded resolution.
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Image !== 'undefined') {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const dims = await new Promise<{ img: HTMLImageElement; width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
        img.onerror = () => reject(new Error('Image decode failed.'));
        img.src = objectUrl;
      });
      if (dims.width > 0 && dims.height > 0) {
        const scale = Math.min(1, maxDimension / Math.max(dims.width, dims.height));
        const width = Math.max(1, Math.round(dims.width * scale));
        const height = Math.max(1, Math.round(dims.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(dims.img, 0, 0, width, height);
          const keepPng = blob.type === 'image/png' && width <= 1024 && height <= 1024;
          const outMime = keepPng ? 'image/png' : 'image/jpeg';
          return canvas.toDataURL(outMime, keepPng ? undefined : 0.88);
        }
      }
    } catch {
      // Fall through to magic-byte normalization when canvas decode is unavailable.
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const detectedMime = detectImageMimeFromBytes(bytes);
  const rawType = (blob.type || '').split(';')[0].trim().toLowerCase();
  const validType = rawType.startsWith('image/') && rawType !== 'image/avif' ? rawType : null;
  const mime = detectedMime || validType || 'image/png';
  return `data:${mime};base64,${uint8ToBase64(bytes)}`;
}

/**
 * Encodes an image attachment URL to a normalized base64 data URL for vision models.
 * Retries cdn.discordapp.com failures against media.discordapp.net.
 */
export async function fetchImageAsBase64(imageUrl: string, signal?: AbortSignal): Promise<string> {
  const fetchOnce = async (url: string): Promise<Blob> => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const declaredSize = Number(response.headers.get('Content-Length') || 0);
    if (declaredSize > 10 * 1024 * 1024) throw new Error('Image exceeds the 10 MB inspection limit.');
    const blob = await response.blob();
    if (blob.size > 10 * 1024 * 1024) throw new Error('Image exceeds the 10 MB inspection limit.');
    return blob;
  };

  try {
    let blob: Blob;
    try {
      blob = await fetchOnce(imageUrl);
    } catch (primaryErr) {
      if (signal?.aborted) throw primaryErr;
      const mediaUrl = imageUrl.replace(/^https:\/\/cdn\.discord(?:app)?\.com\//i, 'https://media.discordapp.net/');
      if (mediaUrl === imageUrl) throw primaryErr;
      blob = await fetchOnce(mediaUrl);
    }
    return await normalizeImageBlobToDataUrl(blob);
  } catch (err) {
    console.error('[VencordAI] Failed to fetch image as base64:', err);
    throw err;
  }
}
