import { parseError, apiFetch } from './helpers.js';

/** A shortcut binding: a single piano note or a chord (array of notes).
 *  null = unbound. */
export interface KeyboardMenuShortcuts {
  prev?: string | string[] | null;
  next?: string | string[] | null;
  enter?: string | string[] | null;
}

export interface GameSettings {
  piano_show_used_keys_only?: boolean;
  octave_agnostic?: boolean;
  low_end_device_mode?: boolean;
  standard_notation?: boolean;
  keyboard_menu_shortcuts?: KeyboardMenuShortcuts;
}

export async function fetchUserSettings(): Promise<GameSettings> {
  const res = await apiFetch('/api/user');
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<GameSettings>;
}

export async function updateUserSettings(settings: Partial<GameSettings>): Promise<GameSettings> {
  const res = await apiFetch('/api/user/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<GameSettings>;
}

/** Delete the logged-in user's account and every entity referencing it.
 *  The server session dies with the account, so the caller must clearAuth()
 *  once this resolves. */
export async function deleteAccount(): Promise<void> {
  const res = await apiFetch('/api/user', { method: 'DELETE' });
  if (!res.ok) throw new Error(await parseError(res));
}
