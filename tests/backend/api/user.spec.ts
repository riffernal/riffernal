import { test, expect } from '@playwright/test';
import {
  authHeaders,
  authJsonHeaders,
  bearer,
  registerUser,
  uniqueUsername,
  seedSongWithNotes,
  seedUserWithScores,
  fetchLeaderboard,
} from '../../helpers/index.js';

test.describe('API: user settings', () => {
  test('GET /api/user returns default settings', async ({ request }) => {
    const jsonHeaders = await authJsonHeaders(request);
    await request.put('/api/user/settings', {
      data: { piano_show_used_keys_only: false },
      headers: jsonHeaders,
    });
    const headers = await authHeaders(request);
    const res = await request.get('/api/user', { headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.piano_show_used_keys_only).toBe(false);
  });

  test('PUT /api/user/settings updates piano_show_used_keys_only', async ({ request }) => {
    const jsonHeaders = await authJsonHeaders(request);
    const res = await request.put('/api/user/settings', {
      data: { piano_show_used_keys_only: true },
      headers: jsonHeaders,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.piano_show_used_keys_only).toBe(true);

    const headers = await authHeaders(request);
    const getRes = await request.get('/api/user', { headers });
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    expect(getBody.piano_show_used_keys_only).toBe(true);
  });

  test('PUT /api/user/settings can set back to false', async ({ request }) => {
    const jsonHeaders = await authJsonHeaders(request);
    await request.put('/api/user/settings', {
      data: { piano_show_used_keys_only: true },
      headers: jsonHeaders,
    });

    const res = await request.put('/api/user/settings', {
      data: { piano_show_used_keys_only: false },
      headers: jsonHeaders,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.piano_show_used_keys_only).toBe(false);
  });

  test('PUT /api/user/settings updates low_end_device_mode', async ({ request }) => {
    const jsonHeaders = await authJsonHeaders(request);
    const res = await request.put('/api/user/settings', {
      data: { low_end_device_mode: true },
      headers: jsonHeaders,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.low_end_device_mode).toBe(true);

    const headers = await authHeaders(request);
    const getRes = await request.get('/api/user', { headers });
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    expect(getBody.low_end_device_mode).toBe(true);
  });

  test('low_end_device_mode can be set back to false', async ({ request }) => {
    const jsonHeaders = await authJsonHeaders(request);
    await request.put('/api/user/settings', {
      data: { low_end_device_mode: true },
      headers: jsonHeaders,
    });

    const res = await request.put('/api/user/settings', {
      data: { low_end_device_mode: false },
      headers: jsonHeaders,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.low_end_device_mode).toBe(false);
  });

  test('PUT /api/user/settings round-trips standard_notation', async ({ request }) => {
    const jsonHeaders = await authJsonHeaders(request);
    const res = await request.put('/api/user/settings', {
      data: { standard_notation: true },
      headers: jsonHeaders,
    });
    expect(res.ok()).toBeTruthy();

    const headers = await authHeaders(request);
    const getRes = await request.get('/api/user', { headers });
    expect(await getRes.json()).toHaveProperty('standard_notation', true);
  });

  test('PUT /api/user/settings handles empty body gracefully', async ({ request }) => {
    const jsonHeaders = await authJsonHeaders(request);
    const res = await request.put('/api/user/settings', {
      data: {},
      headers: jsonHeaders,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('piano_show_used_keys_only');
  });

  test('PUT /api/user/settings round-trips keyboard_menu_shortcuts', async ({ request }) => {
    const jsonHeaders = await authJsonHeaders(request);
    const shortcuts = { prev: 'C3', next: 'D3', enter: 'E3' };
    const res = await request.put('/api/user/settings', {
      data: { keyboard_menu_shortcuts: shortcuts },
      headers: jsonHeaders,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.keyboard_menu_shortcuts).toEqual(shortcuts);

    const headers = await authHeaders(request);
    const getRes = await request.get('/api/user', { headers });
    expect(getRes.ok()).toBeTruthy();
    const getBody = await getRes.json();
    expect(getBody.keyboard_menu_shortcuts).toEqual(shortcuts);
  });
});

test.describe('API: user account deletion', () => {
  test('DELETE /api/user requires authentication', async ({ request }) => {
    const res = await request.delete('/api/user');
    expect(res.status()).toBe(401);
  });

  test('DELETE /api/user refuses to delete the setup admin account', async ({ request }) => {
    // The shared e2e user is the first account in the fresh test DB, so it is
    // the setup admin (MIN(id)) — the one account that must not self-delete.
    const headers = await authHeaders(request);
    const res = await request.delete('/api/user', { headers });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('admin');

    const getRes = await request.get('/api/user', { headers });
    expect(getRes.ok()).toBeTruthy();
  });

  test('DELETE /api/user destroys the account, session and owned songs', async ({ request }) => {
    const { token } = await registerUser(request, uniqueUsername('delete_user'));
    const songId = await seedSongWithNotes(
      request,
      'Account Deletion Song',
      [{ time: 0, key: 'C4', duration: 1 }],
      token,
    );

    // Publish so the song is observable to other users before the deletion.
    const publishRes = await request.put(`/api/songs/${songId}/public-community`, {
      data: { publicCommunity: true },
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
    });
    expect(publishRes.ok()).toBeTruthy();

    const adminHeaders = await authHeaders(request);
    const beforeRes = await request.get(`/api/community/songs/${songId}`, {
      headers: adminHeaders,
    });
    expect(beforeRes.ok()).toBeTruthy();

    const res = await request.delete('/api/user', { headers: bearer(token) });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ ok: true });

    // The session died with the account.
    const getRes = await request.get('/api/user', { headers: bearer(token) });
    expect(getRes.status()).toBe(401);

    // The owned song is gone for everyone, not just the deleted user.
    const afterRes = await request.get(`/api/community/songs/${songId}`, { headers: adminHeaders });
    expect(afterRes.status()).toBe(404);
  });

  test("DELETE /api/user removes the user's daily scores from the leaderboard", async ({
    request,
  }) => {
    // A huge total guarantees a top-10 spot: the board is global and
    // accumulates scores seeded by other specs through the run.
    const seeded = await seedUserWithScores(request, 'delete_scored_user', [999999]);

    const before = await fetchLeaderboard(request, seeded.token);
    expect(before.some((e) => e.username === seeded.user.username)).toBeTruthy();

    const res = await request.delete('/api/user', { headers: bearer(seeded.token) });
    expect(res.ok()).toBeTruthy();

    const adminHeaders = await authHeaders(request);
    const afterRes = await request.get('/api/leaderboard', { headers: adminHeaders });
    expect(afterRes.ok()).toBeTruthy();
    const after = await afterRes.json();
    expect(
      after.some((e: { username: string }) => e.username === seeded.user.username),
    ).toBeFalsy();
  });
});
