/**
 * Tiny i18n layer.
 *
 * - Dictionaries (`en.json`, `cs.json`) ship with the bundle and are picked up
 *   by Vite as plain JSON imports.
 * - The active language is a writable store so reactive components rebind
 *   when it changes (`{$t('nav.home')}`).
 * - Persistence is per-browser via the `lang=` cookie; the SSR layer reads
 *   that cookie in `+layout.server.ts` and seeds the store on hydration.
 *
 * Keep this module SSR-safe: do not touch `document` at module scope.
 */

import { derived, writable, get } from 'svelte/store';
import en from './en.json';
import cs from './cs.json';

export type LangCode = 'en' | 'cs';
export const SUPPORTED: LangCode[] = ['en', 'cs'];

const DICTS: Record<LangCode, any> = { en, cs };

export const lang = writable<LangCode>('en');

/** Look up a dot-path key in the dict; fall back to English, then to the key. */
function lookup(dict: any, key: string): string | undefined {
  const parts = key.split('.');
  let cur: any = dict;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(s: string, vars?: Record<string, any>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

/**
 * Reactive translator. Use as `{$t('key.path', { name: 'X' })}` in markup.
 * Outside of Svelte components prefer `tr(key)` which reads the current
 * value imperatively.
 */
export const t = derived(lang, ($lang) => {
  const primary = DICTS[$lang] ?? DICTS.en;
  const fallback = DICTS.en;
  return (key: string, vars?: Record<string, any>): string => {
    const v = lookup(primary, key) ?? lookup(fallback, key) ?? key;
    return interpolate(v, vars);
  };
});

/** Imperative variant: `tr('key', vars)` — reads the current store value. */
export function tr(key: string, vars?: Record<string, any>): string {
  return get(t)(key, vars);
}

/** Set the language and persist it as a cookie (browser-only). */
export function setLang(code: LangCode): void {
  if (!SUPPORTED.includes(code)) code = 'en';
  lang.set(code);
  if (typeof document !== 'undefined') {
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = `lang=${code}; path=/; max-age=${oneYear}; SameSite=Lax`;
  }
}
