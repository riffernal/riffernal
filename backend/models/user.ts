import { getUserRow, setGameSettingsJson, isAdminUser, deleteUserCascade, type UserRow } from "../db/user.ts";
import { ForbiddenError } from "./validation.ts";

export interface CurrentUser {
  id: number;
}

/** A shortcut binding: one piano note ("C3") after key-by-key capture, or a
 *  chord after multi-key capture ("C3" + "D3" together). null = unbound. */
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

/** Parse the user's persisted game settings JSON. Corrupt or missing JSON
 *  degrades to an empty object — never throws. */
export function parseGameSettings(row: UserRow): GameSettings {
  try {
    return JSON.parse(row.game_settings) as GameSettings;
  } catch {
    return {};
  }
}

/** Read a user's game settings. */
export function getGameSettings(userId: number): GameSettings {
  const row = getUserRow(userId);

  if (!row) return {};
  return parseGameSettings(row);
}

/** Merge the given partial settings into the persisted settings and return
 *  the resulting full settings. The merge is shallow. */
export function updateGameSettings(userId: number, patch: Partial<GameSettings>): GameSettings {
  const current = getGameSettings(userId);
  const merged = { ...current, ...patch };
  setGameSettingsJson(userId, JSON.stringify(merged));
  return merged;
}

/** Destroy the user's account and every entity that references it: their
 *  songs (with other users' bookmarks of and loops copied from those songs,
 *  same as the per-song delete), stats, loops, scores and sessions. The
 *  setup admin is the bootstrap account and cannot self-delete. */
export function deleteUserAccount(userId: number): { ok: boolean } {
  if (isAdminUser(userId)) {
    throw new ForbiddenError("The setup admin account cannot be deleted");
  }

  deleteUserCascade(userId);
  return { ok: true };
}
