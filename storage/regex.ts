/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';

/**
 * Standard structured pattern definitions.
 */
export const STRUCTURED_PATTERNS = {
  OTP: /\b\d{4,8}\b/g,
  PIN: /\b\d{4,6}\b/g,
  EMAIL: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  IPV4: /(?<![0-9a-zA-Z])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![0-9a-zA-Z])/g,
  IPV6: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:|:(?::[0-9a-fA-F]{1,4}){1,7}\b/g,
  HEX_HASH: /\b0x[0-9a-fA-F]{40}\b|\b[0-9a-fA-F]{64}\b|\b[0-9a-fA-F]{32}\b|\b[0-9a-fA-F]{7,40}\b/g,
  HEX_COLOR: /#[0-9a-fA-F]{3,8}\b/g,
  DATE_ISO: /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g,
  DATE_SLASH: /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  DISCORD_INVITE: /\b(?:https?:\/\/)?discord(?:\.gg|\.com\/invite)\/[a-zA-Z0-9-]+\b/g,
  DISCORD_CHANNEL_LINK: /\bhttps?:\/\/discord\.com\/channels\/\d+\/\d+(?:\/\d+)?\b/g,
  SNOWFLAKE_ID: /\b\d{17,20}\b/g,
} as const;

export type StructuredPatternKey = keyof typeof STRUCTURED_PATTERNS;

/**
 * Result of safe regex compilation.
 */
export interface SafeRegexResult {
  regex: RegExp | null;
  isSafe: boolean;
  error?: string;
}

/**
 * Pre-screens a regex string to detect catastrophic backtracking / ReDoS vulnerabilities.
 */
interface Quantifier {
  min: number;
  max: number;
  isLazy: boolean;
  raw: string;
}

interface RegexNode {
  type: 'literal' | 'charClass' | 'group' | 'wildcard' | 'assertion' | 'backref';
  raw: string;
  quantifier?: Quantifier;
  isLookaround?: boolean;
  alternatives?: RegexAlternative[];
  charSetSummary?: string;
}

interface RegexAlternative {
  nodes: RegexNode[];
}

function parseRegexAST(pattern: string): RegexAlternative[] | null {
  let i = 0;
  const n = pattern.length;

  function parseQuantifier(): Quantifier | undefined {
    if (i >= n) return undefined;
    const ch = pattern[i];
    if (ch === '+') {
      i++;
      const isLazy = pattern[i] === '?';
      if (isLazy) i++;
      return { min: 1, max: Infinity, isLazy, raw: '+' + (isLazy ? '?' : '') };
    }
    if (ch === '*') {
      i++;
      const isLazy = pattern[i] === '?';
      if (isLazy) i++;
      return { min: 0, max: Infinity, isLazy, raw: '*' + (isLazy ? '?' : '') };
    }
    if (ch === '?') {
      i++;
      const isLazy = pattern[i] === '?';
      if (isLazy) i++;
      return { min: 0, max: 1, isLazy, raw: '?' + (isLazy ? '?' : '') };
    }
    if (ch === '{') {
      const start = i;
      const closeIdx = pattern.indexOf('}', i);
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 1, closeIdx);
        if (/^\d+(?:,\d*)?$/.test(content)) {
          i = closeIdx + 1;
          const isLazy = pattern[i] === '?';
          if (isLazy) i++;
          const parts = content.split(',');
          const min = parseInt(parts[0], 10);
          const max = parts.length > 1 ? (parts[1] === '' ? Infinity : parseInt(parts[1], 10)) : min;
          return { min, max, isLazy, raw: pattern.slice(start, i) };
        }
      }
    }
    return undefined;
  }

  function parseAlternatives(stopAtCloseParen: boolean): RegexAlternative[] | null {
    const alternatives: RegexAlternative[] = [];
    let currentNodes: RegexNode[] = [];

    while (i < n) {
      const ch = pattern[i];

      if (ch === ')') {
        if (stopAtCloseParen) {
          alternatives.push({ nodes: currentNodes });
          return alternatives;
        }
        return null;
      }

      if (ch === '|') {
        i++;
        alternatives.push({ nodes: currentNodes });
        currentNodes = [];
        continue;
      }

      if (ch === '\\') {
        const start = i;
        i++;
        if (i >= n) return null;
        const escCh = pattern[i];
        i++;
        let node: RegexNode;
        if (/[dDwWsS]/.test(escCh)) {
          node = { type: 'charClass', raw: pattern.slice(start, i), charSetSummary: escCh.toLowerCase() };
        } else if (/[bBAZz]/.test(escCh)) {
          node = { type: 'assertion', raw: pattern.slice(start, i) };
        } else if (/[1-9]/.test(escCh)) {
          node = { type: 'backref', raw: pattern.slice(start, i) };
        } else if (escCh === 'k' && pattern[i] === '<' && pattern.indexOf('>', i) !== -1) {
          i = pattern.indexOf('>', i) + 1;
          node = { type: 'backref', raw: pattern.slice(start, i) };
        } else if (escCh === 'x') {
          i += 2;
          node = { type: 'literal', raw: pattern.slice(start, i) };
        } else if (escCh === 'u') {
          if (pattern[i] === '{') {
            const end = pattern.indexOf('}', i);
            if (end !== -1) {
              i = end + 1;
            }
          } else {
            i += 4;
          }
          node = { type: 'literal', raw: pattern.slice(start, i) };
        } else {
          node = { type: 'literal', raw: pattern.slice(start, i) };
        }
        node.quantifier = parseQuantifier();
        currentNodes.push(node);
        continue;
      }

      if (ch === '[') {
        const start = i;
        i++;
        if (pattern[i] === '^') i++;
        if (pattern[i] === ']') i++;
        while (i < n && pattern[i] !== ']') {
          if (pattern[i] === '\\') {
            i += 2;
          } else {
            i++;
          }
        }
        if (i >= n) return null;
        i++;
        const rawClass = pattern.slice(start, i);
        const node: RegexNode = {
          type: 'charClass',
          raw: rawClass,
          charSetSummary: rawClass,
        };
        node.quantifier = parseQuantifier();
        currentNodes.push(node);
        continue;
      }

      if (ch === '(') {
        const start = i;
        i++;
        let isLookaround = false;
        if (pattern[i] === '?') {
          i++;
          if (pattern[i] === '=' || pattern[i] === '!' || (pattern[i] === '<' && (pattern[i + 1] === '=' || pattern[i + 1] === '!'))) {
            isLookaround = true;
            if (pattern[i] === '<') i += 2;
            else i += 1;
          } else if (pattern[i] === ':') {
            i++;
          } else if (pattern[i] === '<') {
            const endName = pattern.indexOf('>', i);
            if (endName !== -1) {
              i = endName + 1;
            }
          }
        }

        const groupAlts = parseAlternatives(true);
        if (groupAlts === null || i >= n || pattern[i] !== ')') {
          return null;
        }
        i++;
        const node: RegexNode = {
          type: 'group',
          raw: pattern.slice(start, i),
          isLookaround,
          alternatives: groupAlts,
        };
        node.quantifier = parseQuantifier();
        currentNodes.push(node);
        continue;
      }

      if (ch === '.') {
        i++;
        const node: RegexNode = { type: 'wildcard', raw: '.' };
        node.quantifier = parseQuantifier();
        currentNodes.push(node);
        continue;
      }

      if (ch === '^' || ch === '$') {
        i++;
        currentNodes.push({ type: 'assertion', raw: ch });
        continue;
      }

      const start = i;
      i++;
      const node: RegexNode = { type: 'literal', raw: pattern.slice(start, i) };
      node.quantifier = parseQuantifier();
      currentNodes.push(node);
    }

    alternatives.push({ nodes: currentNodes });
    return alternatives;
  }

  const result = parseAlternatives(false);
  return i === n ? result : null;
}

function isDangerousRepetition(q?: Quantifier): boolean {
  if (!q) return false;
  return q.max === Infinity || q.max >= 20 || (q.max > 1 && q.max - q.min >= 10);
}

/**
 * True when a group below `node` has branches that can start with the same character, e.g. the `(b|bc)` in
 * `(a(b|bc)|c)+`, so each iteration can parse the same text two ways. `((cat|dog) )+` is unambiguous: the next
 * character picks the branch. A branch whose start cannot be modelled (empty, optional, or a group) counts as overlapping.
 */
function containsAmbiguousNestedAlternation(node: RegexNode, ctx: ScreenContext): boolean {
  const firstChars = (alt: RegexAlternative): Set<string> | null => {
    const first = alt.nodes[0];
    if (!first || (first.quantifier && first.quantifier.min === 0)) return null;
    return atomCharSet(first, ctx);
  };
  return Boolean(node.alternatives?.some((alt) => alt.nodes.some((child) => {
    if (child.type !== 'group') return false;
    const branches = child.alternatives ?? [];
    if (branches.length > 1) {
      const sets = branches.map(firstChars);
      for (let a = 0; a < sets.length; a++) {
        for (let b = a + 1; b < sets.length; b++) {
          if (charSetsOverlap(sets[a], sets[b])) return true;
        }
      }
    }
    return containsAmbiguousNestedAlternation(child, ctx);
  })));
}

function containsAnyQuantifier(node: RegexNode): boolean {
  if (node.quantifier) return true;
  if (node.type === 'group' && node.alternatives) {
    for (const alt of node.alternatives) {
      for (const child of alt.nodes) {
        if (containsAnyQuantifier(child)) return true;
      }
    }
  }
  return false;
}

const OVERLAP_SAMPLE_CHARS = (() => {
  // ASCII, a few non-Latin letters, every non-ASCII \s character, and the two non-ASCII \w characters under /iu.
  const chars: string[] = ['\t', '\n', '\r', '\v', '\f', 'é', 'É', 'ж', 'Ж', '中', '😀', '\u017f', '\u212a',
    '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'];
  for (let code = 0x20; code < 0x7f; code++) chars.push(String.fromCharCode(code));
  for (let code = 0x2000; code <= 0x200a; code++) chars.push(String.fromCharCode(code));
  return chars;
})();

interface ScreenContext {
  flags: string;
  /** The fixed sample plus every character the pattern names, so two class ranges are compared at their endpoints. */
  sample: string[];
  charSets: Map<RegexNode, Set<string> | null>;
}

function createScreenContext(pattern: string, flags: string): ScreenContext {
  const named = Array.from(pattern);
  for (const m of pattern.matchAll(/\\x([0-9a-fA-F]{2})|\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g)) {
    const code = parseInt(m[1] ?? m[2] ?? m[3], 16);
    if (code <= 0x10ffff) named.push(String.fromCodePoint(code));
  }
  const sample = new Set(OVERLAP_SAMPLE_CHARS);
  for (const char of named) [char, char.toLowerCase(), char.toUpperCase()].forEach((c) => sample.add(c));
  return { flags, sample: Array.from(sample), charSets: new Map() };
}

/** Sample characters a single-character atom can consume; null when it cannot be modelled (groups, backreferences). */
function atomCharSet(node: RegexNode, ctx: ScreenContext): Set<string> | null {
  if (node.type !== 'literal' && node.type !== 'charClass' && node.type !== 'wildcard') return null;
  // Property escapes (`\p{sc=Thai}`) cover characters no sample can enumerate: treat the class as unknown.
  if (/\\[pP]\{/.test(node.raw)) return null;
  if (ctx.charSets.has(node)) return ctx.charSets.get(node)!;
  let result: Set<string> | null = null;
  try {
    const matcher = new RegExp(`^(?:${node.raw})$`, ctx.flags.replace(/[gy]/g, ''));
    const chars = new Set(ctx.sample.filter((char) => matcher.test(char)));
    // An atom that matches no sample character is unknown, not disjoint: treat it as overlapping.
    result = chars.size ? chars : null;
  } catch {
    result = null;
  }
  ctx.charSets.set(node, result);
  return result;
}

function charSetsOverlap(a: Set<string> | null, b: Set<string> | null): boolean {
  if (!a || !b) return true;
  for (const char of a) {
    if (b.has(char)) return true;
  }
  return false;
}

/** A quantifier that can match more than one width (`?`, `*`, `+`, `{m,n}` with n > m); `{1,500}` backtracks like `+`. */
function isVariableWidth(q?: Quantifier): boolean {
  return Boolean(q && q.max > q.min);
}

function containsVariableQuantifier(node: RegexNode): boolean {
  if (isVariableWidth(node.quantifier)) return true;
  return Boolean(node.alternatives?.some((alt) => alt.nodes.some(containsVariableQuantifier)));
}

/**
 * Two consecutive iterations of a repeated group must not be able to split the same text two ways, e.g.
 * `(\w+\s?)+` is rejected but `(\d+\.){3}` passes because the mandatory `\.` separates iterations. A final
 * top-level group of at most two iterations may use the tail exemption, since nothing after it can fail.
 */
function repeatedBodyIsSeparated(node: RegexNode, ctx: ScreenContext, isTail: boolean): boolean {
  const alternatives = node.alternatives || [];
  if (alternatives.length === 1) {
    const body = alternatives[0].nodes;
    return checkUnboundedSequence([...body, ...body], ctx, isTail && node.quantifier!.max === 2);
  }
  const once: RegexNode = { ...node, quantifier: undefined };
  return checkUnboundedSequence([once, once], ctx, false);
}

interface SequenceAtom {
  chars: Set<string> | null;
  separators: Array<Set<string> | null>;
}

/**
 * Rejects two variable-width atoms (unbounded or bounded, e.g. `\w{1,500}`) that can consume the same characters
 * when nothing mandatory and disjoint separates them (e.g. `\w+\s*\w+!`, `a*[a-z]*b`, `(a+)?(a+)?b`,
 * `a{0,1000}a{0,1000}b`). A top-level atom followed only by optional, non-assertion nodes is exempt, because
 * nothing after it can fail and force backtracking.
 */
function checkUnboundedSequence(nodes: RegexNode[], ctx: ScreenContext, allowTail: boolean): boolean {
  const atoms: SequenceAtom[] = [];
  const separate = (chars: Set<string> | null) => atoms.forEach((atom) => atom.separators.push(chars));

  const walk = (sequence: RegexNode[], topLevel: boolean): boolean => {
    for (let index = 0; index < sequence.length; index++) {
      const node = sequence[index];
      const mandatory = !node.quantifier || node.quantifier.min > 0;
      if (node.type === 'assertion' || node.type === 'backref' || node.isLookaround) continue;

      // An optional group (`?`, max 1) is walked like a plain group; any other variable-width node is one atom.
      if (isVariableWidth(node.quantifier) && (node.type !== 'group' || node.quantifier!.max > 1)) {
        const chars = node.type === 'group' ? null : atomCharSet(node, ctx);
        const isTail = topLevel && allowTail && !sequence.slice(index + 1).some((next) =>
          next.type === 'assertion' || !next.quantifier || next.quantifier.min > 0);
        for (const previous of isTail ? [] : atoms) {
          const separated = previous.separators.some((separator) =>
            !charSetsOverlap(separator, previous.chars) || !charSetsOverlap(separator, chars));
          if (!separated && charSetsOverlap(previous.chars, chars)) return false;
        }
        if (mandatory) separate(chars);
        atoms.push({ chars, separators: [] });
      } else if (node.type === 'group' && containsVariableQuantifier(node)) {
        // Separators inside an optional group or a single branch only apply while that branch is taken.
        const base = atoms.map((atom) => atom.separators.length);
        const scoped = !mandatory || (node.alternatives?.length ?? 0) > 1;
        const added: SequenceAtom[] = [];
        for (const alt of node.alternatives || []) {
          if (!walk(alt.nodes, false)) return false;
          added.push(...atoms.splice(base.length));
          if (scoped) atoms.forEach((atom, i) => { atom.separators.length = base[i]; });
        }
        atoms.push(...added);
      } else if (mandatory) {
        separate(node.type === 'group' ? null : atomCharSet(node, ctx));
      }
    }
    return true;
  };

  return walk(nodes, true);
}

function checkASTSafety(alternatives: RegexAlternative[], ctx: ScreenContext, topLevel = true): boolean {
  for (const alt of alternatives) {
    const nodes = alt.nodes;

    if (!checkUnboundedSequence(nodes, ctx, topLevel)) return false;

    for (let j = 0; j < nodes.length - 1; j++) {
      const n1 = nodes[j];
      const n2 = nodes[j + 1];
      if (n1.quantifier && n1.quantifier.max === Infinity && n2.quantifier && n2.quantifier.max === Infinity) {
        if (n1.type === 'wildcard' || n2.type === 'wildcard') return false;
        if (n1.type === 'charClass' && n2.type === 'charClass') {
          if (n1.charSetSummary === n2.charSetSummary || n1.raw === n2.raw) return false;
          if ((n1.charSetSummary === 'w' && n2.charSetSummary === 'd') || (n1.charSetSummary === 'd' && n2.charSetSummary === 'w')) return false;
        }
        if (n1.type === 'literal' && n2.type === 'literal' && n1.raw === n2.raw) return false;
      }
    }

    for (const [index, node] of nodes.entries()) {
      // A quantified backreference (`(a+)\1*`) repeats text of unknown width and character set.
      if (node.type === 'backref' && isVariableWidth(node.quantifier)) return false;

      if (node.type === 'group') {
        const isRepeated = isDangerousRepetition(node.quantifier);
        const repeatsMoreThanOnce = Boolean(node.quantifier && node.quantifier.max > 1);

        const isTail = topLevel && !nodes.slice(index + 1).some((next) =>
          next.type === 'assertion' || !next.quantifier || next.quantifier.min > 0);
        if (repeatsMoreThanOnce && containsVariableQuantifier({ ...node, quantifier: undefined })
          && !repeatedBodyIsSeparated(node, ctx, isTail)) {
          return false;
        }

        if (repeatsMoreThanOnce && node.alternatives && node.alternatives.length > 1) {
          const firstSets = node.alternatives.map((a) => {
            const first = a.nodes[0];
            return first?.type === 'literal' ? atomCharSet(first, ctx) : null;
          });
          for (let a1 = 0; a1 < firstSets.length; a1++) {
            for (let a2 = a1 + 1; a2 < firstSets.length; a2++) {
              if (charSetsOverlap(firstSets[a1], firstSets[a2])) return false;
            }
          }
        }

        if (node.isLookaround && (isRepeated || node.quantifier)) {
          return false;
        }

        if (isRepeated) {
          // A branch point inside a repeated group lets each iteration parse the same text two ways.
          if (containsAmbiguousNestedAlternation(node, ctx)) return false;
          if (node.alternatives) {
            for (const groupAlt of node.alternatives) {
              for (const child of groupAlt.nodes) {
                if (containsAnyQuantifier(child)) {
                  return false;
                }
              }
            }
          }
        }

        if (node.alternatives && node.alternatives.length > 1) {
          if (isRepeated) {
            if (node.alternatives.some((a) => a.nodes.length === 0)) {
              return false;
            }

            if (node.alternatives.some((a) => a.nodes.some(containsAnyQuantifier))) {
              return false;
            }

            const rawBranches = node.alternatives.map((a) => a.nodes.map((n) => n.raw).join(''));
            const unique = new Set(rawBranches);
            if (unique.size !== rawBranches.length) {
              return false;
            }

            for (let a1 = 0; a1 < rawBranches.length; a1++) {
              for (let a2 = a1 + 1; a2 < rawBranches.length; a2++) {
                const b1 = rawBranches[a1];
                const b2 = rawBranches[a2];
                if (!b1 || !b2) return false;
                if (b1.startsWith(b2) || b2.startsWith(b1) || b1.endsWith(b2) || b2.endsWith(b1)) {
                  return false;
                }
                const f1 = node.alternatives[a1].nodes[0];
                const f2 = node.alternatives[a2].nodes[0];
                if (f1 && f2) {
                  if (f1.raw === f2.raw) return false;
                  if (f1.type === 'wildcard' || f2.type === 'wildcard') return false;
                  if (f1.type === 'charClass' && f2.type === 'charClass' && f1.charSetSummary === f2.charSetSummary) return false;
                }
              }
            }
          }
        }

        if (node.alternatives) {
          if (!checkASTSafety(node.alternatives, ctx, false)) {
            return false;
          }
        }
      }
    }
  }

  return true;
}

/**
 * Pre-screens a regex string to detect catastrophic backtracking / ReDoS vulnerabilities.
 */
export function isRegexSafe(patternStr: string, flags = ''): boolean {
  if (!patternStr || typeof patternStr !== 'string') return false;
  if (patternStr.length > 1000) return false;

  try {
    new RegExp(patternStr, flags);
  } catch {
    return false;
  }

  // AST-level structural safety verification
  const ast = parseRegexAST(patternStr);
  if (!ast) return false;

  return checkASTSafety(ast, createScreenContext(patternStr, flags));
}

/**
 * Compiles a string or RegExp pattern safely with global flag and ReDoS screening.
 */
export function compileSafeRegex(
  pattern: string | RegExp,
  defaultFlags = 'g',
): SafeRegexResult {
  if (!pattern) {
    return { regex: null, isSafe: false, error: 'Empty pattern provided' };
  }

  try {
    if (pattern instanceof RegExp) {
      const source = pattern.source;
      if (!isRegexSafe(source, pattern.flags)) {
        return { regex: null, isSafe: false, error: 'Pattern failed ReDoS safety analysis (nested quantifiers detected)' };
      }
      const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      return { regex: new RegExp(source, flags), isSafe: true };
    }

    const trimmed = pattern.trim();
    if (!trimmed) {
      return { regex: null, isSafe: false, error: 'Empty pattern string' };
    }

    let source = trimmed;
    let flags = defaultFlags;

    const slashMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
    if (slashMatch) {
      source = slashMatch[1];
      flags = slashMatch[2].includes('g') ? slashMatch[2] : slashMatch[2] + 'g';
    }

    if (!isRegexSafe(source, flags)) {
      return { regex: null, isSafe: false, error: 'Pattern failed ReDoS safety analysis (nested quantifiers detected)' };
    }

    return { regex: new RegExp(source, flags), isSafe: true };
  } catch (err) {
    return { regex: null, isSafe: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Extracts pattern matches from text with execution timeout and iteration bounds.
 */
export function extractMatchesFromText(
  text: string,
  pattern: string | RegExp,
  maxMatches = 50,
  timeLimitMs = 15,
): string[] {
  if (!text || !pattern) return [];

  const safe = compileSafeRegex(pattern);
  if (!safe.isSafe || !safe.regex) return [];

  const regex = safe.regex;
  const matches: string[] = [];
  const boundedText = text.slice(0, 10_000); // 10k character limit per scan
  const startTime = Date.now();

  try {
    let match: RegExpExecArray | null;
    let guard = 0;

    while ((match = regex.exec(boundedText)) !== null && guard++ < maxMatches) {
      if (Date.now() - startTime > timeLimitMs) {
        break; // Guard against execution stall
      }

      if (match[0]) {
        matches.push(match[0]);
      } else {
        regex.lastIndex++;
      }
    }
  } catch {
    return [];
  }

  return Array.from(new Set(matches));
}

/**
 * Extracts structured pattern matches across all Discord message fields (content, attachments, embeds).
 */
export function extractMessagePatternMatches(
  message: DiscordMessage,
  pattern: string | RegExp,
  maxMatches = 50,
): string[] {
  if (!message) return [];

  const parts: string[] = [];
  if (message.content) parts.push(message.content);
  if (message.attachments) {
    for (const a of message.attachments) {
      if (a.filename) parts.push(a.filename);
      if (a.description) parts.push(a.description);
    }
  }
  if (message.embeds) {
    for (const e of message.embeds) {
      if (e.title) parts.push(e.title);
      if (e.description) parts.push(e.description);
    }
  }

  const combined = parts.join(' ');
  return extractMatchesFromText(combined, pattern, maxMatches);
}

/**
 * Detects whether a text contains specific known entities and returns them in a structured record.
 */
export function extractAllStructuredEntities(text: string): Record<StructuredPatternKey, string[]> {
  const result: Partial<Record<StructuredPatternKey, string[]>> = {};

  for (const [key, pattern] of Object.entries(STRUCTURED_PATTERNS) as Array<[StructuredPatternKey, RegExp]>) {
    result[key] = extractMatchesFromText(text, pattern, 20);
  }

  return result as Record<StructuredPatternKey, string[]>;
}
