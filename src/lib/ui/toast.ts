/**
 * Minimal toast store.
 *
 * Replaces `alert()` for API feedback: blocking native dialogs (which used to
 * print the raw JSON error body) are neither localisable nor dismissible in a
 * consistent way. Toasts are rendered once by `Toaster.svelte` in the root
 * layout, so any component can call `toastError(...)` / `toastSuccess(...)`.
 */
import { writable } from 'svelte/store';

export type ToastKind = 'error' | 'success' | 'info';
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

const DURATION: Record<ToastKind, number> = {
  error: 9000,      // failures deserve time to be read
  success: 3000,
  info: 5000
};

export const toasts = writable<Toast[]>([]);

let nextId = 1;

export function dismissToast(id: number): void {
  toasts.update(list => list.filter(t => t.id !== id));
}

export function pushToast(kind: ToastKind, text: string): number {
  const message = String(text ?? '').trim();
  if (!message) return 0;
  const id = nextId++;
  // Collapse an identical message that is already on screen instead of
  // stacking duplicates (e.g. a group action failing for every member).
  let duplicate = false;
  toasts.update(list => {
    duplicate = list.some(t => t.kind === kind && t.text === message);
    return duplicate ? list : [...list, { id, kind, text: message }];
  });
  if (duplicate) return 0;
  if (typeof window !== 'undefined') {
    setTimeout(() => dismissToast(id), DURATION[kind]);
  }
  return id;
}

export const toastError   = (text: string) => pushToast('error', text);
export const toastSuccess = (text: string) => pushToast('success', text);
export const toastInfo    = (text: string) => pushToast('info', text);
