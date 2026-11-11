import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  wipeDatabase,
  deleteSong,
  seedSongWithNotes,
  goToSongList,
  uniqueUsername,
  registerUser,
  expectHomeScreenActive,
  expectHomeScreenInactive,
  expectAuthScreenActive,
  expectMenuScreenActive,
  clickLogout,
  openSettings,
  themeOptions,
  themeOption,
  authHeaders,
  authJsonHeaders,
  bearer,
  clickFreeplay,
} from '../../helpers/index.js';

test.describe('Menu Screen', () => {
  test.beforeEach(async ({ request }: { request: APIRequestContext }) => {
    await wipeDatabase(request);
    // Reset user settings to defaults (the e2e request fixture carries no
    // auth, so headers must be attached explicitly)
    await request.put('/api/user/settings', {
      data: { piano_show_used_keys_only: false, low_end_device_mode: false },
      headers: await authJsonHeaders(request),
    });
  });

  test('displays title', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.home-title')).toContainText('RIFFERNAL');
  });

  test('shows empty state when no songs exist', async ({ page }) => {
    await goToSongList(page);
    await expect(page.locator('.empty-song-list')).toBeVisible({ timeout: 5000 });
  });

  test('shows song list with imported song', async ({ request, page }) => {
    const id = await seedSongWithNotes(request, 'E2E Menu Song', [
      { time: 0.5, key: 'C4', duration: 1 },
    ]);
    try {
      await goToSongList(page);
      await expect(page.locator('.song-item').first()).toBeVisible({ timeout: 5000 });
      await expect(page.locator('.song-item').first()).toContainText('E2E Menu Song');
    } finally {
      await deleteSong(request, id);
    }
  });

  test('loads song lists on freeplay entry, not on home', async ({ request, page }) => {
    const publisher = await registerUser(request, uniqueUsername('songlist_pub'));
    const publishedIds: number[] = [];
    const publishAs = async (title: string): Promise<void> => {
      const id = await seedSongWithNotes(
        request,
        title,
        [{ time: 0.5, key: 'C4', duration: 1 }],
        publisher.token,
      );
      publishedIds.push(id);
      const res = await request.put(`/api/songs/${id}/public-community`, {
        data: { publicCommunity: true },
        headers: { ...bearer(publisher.token), 'Content-Type': 'application/json' },
      });
      expect(res.ok()).toBeTruthy();
    };

    try {
      await publishAs('E2E-SongList-One');

      const listPaths: string[] = [];
      page.on('request', (req) => {
        const path = new URL(req.url()).pathname;

        if (
          req.method() === 'GET' &&
          (path === '/api/library' || path === '/api/community/songs')
        ) {
          listPaths.push(path);
        }
      });

      // The home screen boots without touching the song lists.
      await page.goto('/');
      await expectHomeScreenActive(page);
      // setupMidiStatus runs after app init settles, so waiting for it proves
      // any initial list load would have fired by now.
      await page.waitForFunction(
        () => (document.getElementById('midi-status-home') as HTMLElement).textContent.length > 0,
      );
      expect(listPaths).toEqual([]);

      await clickFreeplay(page);
      await expect(
        page.locator('.community-section .community-song', { hasText: 'E2E-SongList-One' }),
      ).toBeVisible({ timeout: 5000 });
      expect(listPaths).toHaveLength(2);

      // Back on home nothing re-fetches the lists.
      await page.locator('#freeplay-screen .brand-corner').click();
      await expectHomeScreenActive(page);
      expect(listPaths).toHaveLength(2);

      // A song published while on home lands on the next freeplay entry.
      await publishAs('E2E-SongList-Two');
      expect(listPaths).toHaveLength(2);

      await clickFreeplay(page);
      await expect(
        page.locator('.community-section .community-song', { hasText: 'E2E-SongList-Two' }),
      ).toBeVisible({ timeout: 5000 });
      expect(listPaths).toHaveLength(4);
    } finally {
      // Publisher-owned songs survive wipeDatabase (it only deletes the
      // shared admin user's songs), so remove them explicitly.
      for (const id of publishedIds) {
        await request.delete(`/api/songs/${id}`, { headers: bearer(publisher.token) });
      }
    }
  });

  test('shows controls hint', async ({ page }) => {
    await goToSongList(page);
    await expect(page.locator('.controls-hint')).toBeVisible();
    await expect(page.locator('.controls-hint')).toContainText('white keys');
  });

  test('start button is visible', async ({ page }) => {
    await goToSongList(page);
    await expect(page.locator('#btn-start')).toBeVisible();
    await expect(page.locator('#btn-start')).toContainText('PLAY');
  });

  test('show used keys toggle is visible on settings popup', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await expect(page.locator('#show-used-keys')).toBeVisible();
    await expect(page.locator('.setting-toggle').first()).toContainText(
      'Show only keys used in song',
    );
  });

  test('show used keys toggle can be toggled', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    const checkbox = page.locator('#show-used-keys');
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
  });

  test('show used keys toggle is checked by default for a new user', async ({ request, page }) => {
    // A fresh user has no persisted settings, so the client-side default applies.
    const username = uniqueUsername('used_keys_user');
    const { user, token } = await registerUser(request, username);

    await page.goto('/');
    await page.evaluate(
      ([t, u]) => {
        localStorage.setItem('riffernal_token', t);
        localStorage.setItem('riffernal_user', u);
      },
      [token, JSON.stringify(user)],
    );
    await page.reload();
    await expectHomeScreenActive(page);

    await openSettings(page);
    await expect(page.locator('#show-used-keys')).toBeChecked();
  });

  test('low-end device mode toggle is visible on settings popup', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await expect(page.locator('#low-end-device-mode')).toBeVisible();
    await expect(page.locator('.setting-toggle').nth(2)).toContainText(
      'Low-end device mode (optimized graphics)',
    );
  });

  test('low-end device mode toggle can be toggled and persists across reload', async ({
    request,
    page,
  }) => {
    await page.goto('/');
    await openSettings(page);
    const checkbox = page.locator('#low-end-device-mode');
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // The save is fire-and-forget, so wait for it to land before reloading.
    const headers = await authHeaders(request);
    await expect
      .poll(async () => {
        const res = await request.get('/api/user', { headers });
        return (await res.json()).low_end_device_mode;
      })
      .toBe(true);

    await page.reload();
    await openSettings(page);
    await expect(page.locator('#low-end-device-mode')).toBeChecked();

    await page.locator('#low-end-device-mode').uncheck();
    await expect(page.locator('#low-end-device-mode')).not.toBeChecked();
  });

  test('logout card logs out and shows auth screen with the guest option', async ({
    request,
    page,
  }) => {
    // Use a throwaway user so the shared e2e session is never invalidated.
    const username = uniqueUsername('logout_user');
    const { user, token } = await registerUser(request, username);

    // Boot the app as the throwaway user by seeding its credentials into localStorage.
    await page.goto('/');
    await page.evaluate(
      ([t, u]) => {
        localStorage.setItem('riffernal_token', t);
        localStorage.setItem('riffernal_user', u);
      },
      [token, JSON.stringify(user)],
    );
    await page.reload();
    await expectHomeScreenActive(page);

    await clickLogout(page);

    await expectAuthScreenActive(page);
    await expectHomeScreenInactive(page);

    // Logged back out, the visitor can choose the guest shelf again.
    await expect(page.locator('#auth-guest-btn')).toBeVisible();
    await page.locator('#auth-guest-btn').click();
    await expectMenuScreenActive(page);
    await expect(page.locator('#btn-guest-signin')).toBeVisible();
  });

  test('delete account in settings destroys the session and returns to the auth screen', async ({
    request,
    page,
  }) => {
    // Throwaway user: the shared e2e user is the setup admin, which is
    // protected from self-deletion, and its session must survive anyway.
    const username = uniqueUsername('delete_user');
    const { user, token } = await registerUser(request, username);

    await page.goto('/');
    await page.evaluate(
      ([t, u]) => {
        localStorage.setItem('riffernal_token', t);
        localStorage.setItem('riffernal_user', u);
      },
      [token, JSON.stringify(user)],
    );
    await page.reload();
    await expectHomeScreenActive(page);

    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    await openSettings(page);
    await page.locator('#btn-delete-account').click();

    await expectAuthScreenActive(page);
    await expectHomeScreenInactive(page);
    // Local auth state was cleared with the account.
    expect(await page.evaluate(() => localStorage.getItem('riffernal_token'))).toBeNull();
  });

  test('theme selector in settings popup switches active theme', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);

    const options = themeOptions(page);
    await expect(options).toHaveCount(2);
    await expect(themeOption(page, 0)).toHaveClass(/active/);

    await themeOption(page, 1).click();

    await expect(themeOption(page, 1)).toHaveClass(/active/);
    await expect(themeOption(page, 0)).not.toHaveClass(/active/);
  });
});
