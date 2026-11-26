import { test, expect } from '@playwright/test';
import {
  startGame,
  CANVAS_HEIGHT,
  ADD_LOOP_BTN,
  CLEAR_LOOPS_BTN,
  CLEAR_LOOPS_CANCEL_BTN,
  CLEAR_LOOPS_OK_BTN,
  CLEAR_LOOPS_POPUP,
  CLOSE_SHEET_BTN,
  DEFINE_LOOP_BTN,
  LOOP_CONTROL,
  LOOPS_ROW,
  LOOP_STATUS,
  OPEN_SHEET_BTN,
  SHEET_CANVAS,
  SHEET_HINT,
  SHEET_NEXT_BTN,
  SHEET_PAGE_INFO,
  closeSongInfoPopup,
  gameState,
  expectLoopStatus,
  expectSheetScreenActive,
  expectSheetScreenInactive,
  openSheet,
  closeSheet,
  authHeaders,
} from '../../../helpers/index.js';

// -- UI tests (DOM only) ----------------------------------------------------

test.describe('Loops - UI', () => {
  test('loop control is visible on play screen with "No loops" status', async ({ page }) => {
    await startGame(page);
    await expect(page.locator(LOOP_CONTROL)).toBeVisible();
    await expect(page.locator(DEFINE_LOOP_BTN)).toBeVisible();
    await expectLoopStatus(page, 'No loops');
    await expect(page.locator(OPEN_SHEET_BTN)).toBeVisible();
  });

  test('clicking define loop switches to learn mode and opens sheet', async ({ page }) => {
    await startGame(page);
    await page.locator(DEFINE_LOOP_BTN).click();
    await expect(page.locator('#mode-learn')).toHaveClass(/active/);
    await expectSheetScreenActive(page);
  });

  test('Add loop button enters start phase prompting for start note', async ({ page }) => {
    await startGame(page);
    await page.locator(DEFINE_LOOP_BTN).click();
    await expectSheetScreenActive(page);
    await page.locator(ADD_LOOP_BTN).click();
    await expect(page.locator(DEFINE_LOOP_BTN)).toHaveClass(/active/);
    await expect(page.locator(SHEET_HINT)).toHaveText('Click the start note');
    await expectLoopStatus(page, 'Click start note');
  });

  test('Add loop button re-enters start phase after closing and re-opening', async ({ page }) => {
    await startGame(page);
    await page.locator(DEFINE_LOOP_BTN).click();
    await page.locator(ADD_LOOP_BTN).click();
    await expectLoopStatus(page, 'Click start note');
    await page.locator(CLOSE_SHEET_BTN).click();
    await expectSheetScreenInactive(page);
    await page.locator(DEFINE_LOOP_BTN).click();
    await page.locator(ADD_LOOP_BTN).click();
    await expectSheetScreenActive(page);
    await expectLoopStatus(page, 'Click start note');
  });

  test('clear all loops button resets draft status to "No loops" without a confirmation', async ({
    page,
  }) => {
    await startGame(page);
    await page.locator(DEFINE_LOOP_BTN).click();
    await page.locator(ADD_LOOP_BTN).click();
    await expect(page.locator(LOOP_STATUS)).not.toHaveText('No loops');
    await page.locator(CLEAR_LOOPS_BTN).click();
    await expectLoopStatus(page, 'No loops');
    await expect(page.locator(CLEAR_LOOPS_POPUP)).toBeHidden();
  });

  test('clear all loops button requires confirmation and removes saved loops from the UI and the database', async ({
    page,
  }) => {
    await startGame(page, {
      keepSong: true,
      notes: [
        { time: 0.5, key: 'C3', duration: 0.25 },
        { time: 3.0, key: 'E3', duration: 0.25 },
        { time: 8.0, key: 'G3', duration: 0.25 },
        { time: 12.0, key: 'A3', duration: 0.25 },
      ],
      loops: [
        { startTime: 3.0, endTime: 7.0, enabled: true },
        { startTime: 8.0, endTime: 12.0, enabled: true },
      ],
    });
    await closeSongInfoPopup(page);

    await openSheet(page);
    await expect(page.locator(LOOPS_ROW)).toHaveCount(2);

    // Dismissing keeps the loops — this is the safety net for the
    // previously one-click wipe.
    await page.locator(CLEAR_LOOPS_BTN).click();
    await expect(page.locator(CLEAR_LOOPS_POPUP)).toBeVisible();
    await page.locator(CLEAR_LOOPS_CANCEL_BTN).click();
    await expect(page.locator(CLEAR_LOOPS_POPUP)).toBeHidden();
    await expect(page.locator(LOOPS_ROW)).toHaveCount(2);

    await page.locator(CLEAR_LOOPS_BTN).click();
    await page.locator(CLEAR_LOOPS_OK_BTN).click();
    await expect(page.locator(CLEAR_LOOPS_POPUP)).toBeHidden();
    await expect(page.locator(LOOPS_ROW)).toHaveCount(0);
    await closeSheet(page);
    await expectLoopStatus(page, 'No loops');

    const request = page.context().request;
    const headers = await authHeaders(request);
    const songs = await (await request.get('/api/songs', { headers })).json();
    const songId = (Array.isArray(songs) ? songs : songs.songs)[0].id;
    const loops = await (await request.get(`/api/songs/${songId}/loops`, { headers })).json();
    expect(loops).toEqual([]);
  });

  test('standard notation view is selectable and persists', async ({ page }) => {
    await startGame(page);
    await page.locator('#notation-sheet').click();
    await expect(page.locator('#notation-sheet')).toHaveClass(/active/);
    await expect(page.locator('#notation-highway')).not.toHaveClass(/active/);
    await expect
      .poll(() => page.evaluate(() => (window as any)._game.renderer.standardNotation))
      .toBe(true);
    await expect(page.locator('#sheet-resize-handle')).toBeHidden();

    await page.locator('#notation-highway').click();
    await expect(page.locator('#notation-highway')).toHaveClass(/active/);
    await expect(page.locator('#sheet-resize-handle')).toBeVisible();
  });

  test('piano-key hover shows standard note names', async ({ page }) => {
    await startGame(page);
    await closeSongInfoPopup(page);
    await page.evaluate(() => {
      (window as any)._game.setShowUsedKeys(false);
    });
    const positions = await page.evaluate(() => {
      const g = (window as any)._game;
      const rect = document.getElementById('gameCanvas')!.getBoundingClientRect();
      return ['C4', 'C#4'].map((key) => {
        const layout = g.renderer.pianoKeyLayout(key, g.usedNoteRange);
        return {
          key,
          x: rect.left + layout.x + layout.width / 2,
          y: rect.top + layout.y + layout.height * (key.includes('#') ? 0.5 : 0.85),
        };
      });
    });

    for (const position of positions) {
      await page.mouse.move(position.x, position.y);
      await expect(page.locator('.pixel-tooltip')).toHaveText(position.key);
    }

    const canvas = await page.locator('#gameCanvas').boundingBox();
    await page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 3);
    await expect(page.locator('.pixel-tooltip')).toBeHidden();
  });

  test('open-sheet button toggles the full sheet view', async ({ page }) => {
    await startGame(page);
    await expectSheetScreenInactive(page);
    await openSheet(page);
    await expect(page.locator(SHEET_PAGE_INFO)).toContainText(/1 \//);
    await closeSheet(page);
  });

  test('Escape closes the sheet view', async ({ page }) => {
    await startGame(page);
    await openSheet(page);
    await page.keyboard.press('Escape');
    await expectSheetScreenInactive(page);
  });

  test('clicking a note in the full sheet view seeks the game to that note', async ({ page }) => {
    await startGame(page);

    await openSheet(page);

    await page.locator(SHEET_NEXT_BTN).click();
    await expect(page.locator(SHEET_PAGE_INFO)).toContainText('2 /');

    const target = await page.evaluate(async () => {
      const g = (window as any)._game;
      // @ts-expect-error browser-side dynamic import
      const { Renderer, SHEET_BEATS_VISIBLE } = await import('/js/game/rendering/Renderer.js');
      const canvas = document.getElementById('sheet-canvas') as HTMLCanvasElement;
      const renderer = new Renderer(canvas);
      renderer.sheetScale = 1.5;
      const pageDuration = SHEET_BEATS_VISIBLE * (60 / g.songBpm);
      const start = pageDuration;
      const note = g.noteManager.notes.find((candidate: any) => candidate.time >= start);
      renderer.drawSheetMusic(
        g.noteManager.trebleNotes,
        g.noteManager.bassNotes,
        g.currentTime,
        g.noteManager.getSongDuration(),
        undefined,
        { start, end: start + pageDuration },
        g.songBpm,
      );
      return renderer.notePixelPosition(note!);
    });
    const rect = await page.locator(SHEET_CANVAS).boundingBox();
    expect(rect).not.toBeNull();
    await page.mouse.click(rect!.x + target!.x, rect!.y + target!.y);

    await expectSheetScreenInactive(page);
    await openSheet(page);
    await expect(page.locator(SHEET_PAGE_INFO)).toContainText('2 /');
  });

  test('clicking a note on the game-screen sheet seeks the game without opening the full sheet', async ({
    page,
  }) => {
    await startGame(page);
    await closeSongInfoPopup(page);
    await page.waitForFunction(() => {
      const g = (window as any)._game;
      return g && g.renderer.sheetBarW > 0;
    });
    // Pause so the scrolling sheet doesn't move the note between reading its
    // pixel position and clicking it.
    const target = await page.evaluate(() => {
      const g = (window as any)._game;
      g.pause();
      const note = g.noteManager.notes[0];
      const pos = g.renderer.notePixelPosition(note);
      const rect = document.getElementById('gameCanvas')!.getBoundingClientRect();
      return { x: rect.left + pos.x, y: rect.top + pos.y, time: note.time };
    });
    await page.mouse.click(target.x, target.y);
    await expectSheetScreenInactive(page);
    const state = await gameState(page);
    expect(state.currentTime).toBeGreaterThanOrEqual(target.time);
  });

  test('hovering a note on the game-screen sheet shows its time and hides it off-note', async ({
    page,
  }) => {
    await startGame(page);
    await closeSongInfoPopup(page);
    await page.waitForFunction(() => {
      const g = (window as any)._game;
      return g && g.renderer.sheetBarW > 0;
    });
    const target = await page.evaluate(() => {
      const g = (window as any)._game;
      g.pause();
      const note = g.noteManager.notes[0];
      const pos = g.renderer.notePixelPosition(note);
      const rect = document.getElementById('gameCanvas')!.getBoundingClientRect();
      return { x: rect.left + pos.x, y: rect.top + pos.y, time: note.time };
    });
    const tooltip = page.locator('.pixel-tooltip');
    const m = Math.floor(target.time / 60);
    const sec = Math.floor(target.time % 60)
      .toString()
      .padStart(2, '0');
    const ms = Math.round((target.time % 1) * 1000)
      .toString()
      .padStart(3, '0');

    await page.mouse.move(target.x, target.y);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(`${m}:${sec}.${ms}`);

    const rect = await page.locator('#gameCanvas').boundingBox();
    await page.mouse.move(rect!.x + rect!.width * 0.5, rect!.y + rect!.height * 0.5);
    await expect(tooltip).toBeHidden();
  });

  test('hovering a note in the full sheet view shows its time', async ({ page }) => {
    await startGame(page);
    await closeSongInfoPopup(page);
    await openSheet(page);
    await page.locator(SHEET_NEXT_BTN).click();
    await expect(page.locator(SHEET_PAGE_INFO)).toContainText('2 /');

    const target = await page.evaluate(async () => {
      const g = (window as any)._game;
      // @ts-expect-error browser-side dynamic import
      const { Renderer, SHEET_BEATS_VISIBLE } = await import('/js/game/rendering/Renderer.js');
      const canvas = document.getElementById('sheet-canvas') as HTMLCanvasElement;
      const renderer = new Renderer(canvas);
      renderer.sheetScale = 1.5;
      const pageDuration = SHEET_BEATS_VISIBLE * (60 / g.songBpm);
      const start = pageDuration;
      const note = g.noteManager.trebleNotes.find((candidate: any) => candidate.time >= start);
      renderer.drawSheetMusic(
        g.noteManager.trebleNotes,
        g.noteManager.bassNotes,
        g.currentTime,
        g.noteManager.getSongDuration(),
        undefined,
        { start, end: start + pageDuration },
        g.songBpm,
      );
      return renderer.notePixelPosition(note!);
    });
    const rect = await page.locator(SHEET_CANVAS).boundingBox();
    await page.mouse.move(rect!.x + target.x, rect!.y + target.y);
    await expect(page.locator('.pixel-tooltip')).toBeVisible();
    await expect(page.locator('.pixel-tooltip')).toHaveText(/^\d+:\d{2}\.\d{3}$/);
  });

  test('clicking outside the sheet notes does not seek the game', async ({ page }) => {
    await startGame(page);
    await closeSongInfoPopup(page);
    await page.waitForFunction(() => {
      const g = (window as any)._game;
      return g && g.renderer.sheetBarW > 0;
    });
    await page.evaluate(() => {
      (window as any)._game.pause();
    });
    const before = (await gameState(page)).currentTime;
    const rect = await page.locator('#gameCanvas').boundingBox();
    expect(rect).not.toBeNull();
    // Empty sheet-staff space, far from any visible note.
    await page.mouse.click(rect!.x + rect!.width * 0.05, rect!.y + 110);
    // Falling-notes highway below the sheet.
    await page.mouse.click(rect!.x + rect!.width * 0.5, rect!.y + rect!.height * 0.6);
    // Piano area at the bottom.
    await page.mouse.click(rect!.x + rect!.width * 0.5, rect!.y + rect!.height * 0.95);
    const after = (await gameState(page)).currentTime;
    expect(after).toBe(before);
  });

  test('next sheet page does not retain the previous page loop overlay or highlighted notes', async ({
    page,
  }) => {
    const notes: Array<{ time: number; key: string; duration: number }> = [];
    const keys = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'];

    for (let i = 0; i < 100; i++) {
      notes.push({ time: 0.5 + i * 0.6, key: keys[i % keys.length], duration: 0.3 });
    }

    // Loop spans pages 1 and 2 (page = 18 beats @ 120bpm = 9s): page 2 must
    // show only the [9s, 10s] tail, with no overlay carried over from page 1.
    await startGame(page, {
      keepSong: true,
      songTitle: 'SheetPageClear',
      notes,
      loops: [{ startTime: 1.0, endTime: 10.0, enabled: true }],
    });

    await closeSongInfoPopup(page);
    await openSheet(page);
    await page.locator(ADD_LOOP_BTN).click();
    await page.locator(SHEET_NEXT_BTN).click();
    await expect(page.locator(SHEET_PAGE_INFO)).toContainText('2 /');

    // Scan past the loop-end marker column (t=10s ≈ x=93 device px): any
    // wide horizontal run of purple-tinted pixels is stale page-1 overlay.
    const maxRun = await page.evaluate(() => {
      const canvas = document.getElementById('sheet-canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const x0 = 100;
      const y0 = 42;
      const y1 = Math.min(115, canvas.height);
      const img = ctx.getImageData(x0, y0, canvas.width - x0, y1 - y0);
      const w = img.width;
      let maxRun = 0;

      for (let y = 0; y < img.height; y++) {
        let run = 0;

        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;

          if (img.data[i + 2] - img.data[i] > 12 && img.data[i + 2] > 40) {
            run++;
            maxRun = Math.max(maxRun, run);
          } else {
            run = 0;
          }
        }
      }

      return maxRun;
    });

    expect(maxRun).toBeLessThan(25);
  });

  test('renaming a loop updates the panel, the HUD status, and persists', async ({ page }) => {
    await startGame(page, {
      keepSong: true,
      songTitle: 'RenameLoop',
      notes: [
        { time: 0.5, key: 'C3', duration: 0.25 },
        { time: 5.0, key: 'E3', duration: 0.25 },
        { time: 8.0, key: 'G3', duration: 0.25 },
      ],
      loops: [{ startTime: 5.0, endTime: 8.0, enabled: true }],
    });
    await closeSongInfoPopup(page);

    await openSheet(page);
    const row = page.locator(LOOPS_ROW).first();
    // Unnamed loops show a positional default derived from start order.
    await expect(row.locator('.loop-row-name')).toHaveText('Loop 1');

    await row.locator('.loop-row-name').click();
    const input = row.locator('.loop-row-name-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('Chorus A');
    await input.press('Enter');
    await expect(row.locator('.loop-row-name')).toHaveText('Chorus A');
    await closeSheet(page);

    // The currently-playing loop now shows its name in the play-zone HUD.
    await expectLoopStatus(page, 'Chorus A (0:05-0:08)');

    const request = page.context().request;
    const headers = await authHeaders(request);
    const songs = await (await request.get('/api/songs', { headers })).json();
    const songId = (Array.isArray(songs) ? songs : songs.songs)[0].id;
    const loops = await (await request.get(`/api/songs/${songId}/loops`, { headers })).json();
    expect(loops).toHaveLength(1);
    expect(loops[0].name).toBe('Chorus A');
  });

  test('trim button removes the last note of a loop and persists the change', async ({ page }) => {
    await startGame(page, {
      keepSong: true,
      songTitle: 'TrimLoop',
      notes: [
        { time: 3.0, key: 'C3', duration: 0.25 },
        { time: 5.0, key: 'E3', duration: 0.25 },
        { time: 8.0, key: 'G3', duration: 0.25 },
        { time: 9.0, key: 'A3', duration: 0.25 },
      ],
      loops: [{ startTime: 3.0, endTime: 8.0, enabled: true }],
    });
    await closeSongInfoPopup(page);

    await openSheet(page);
    const row = page.locator(LOOPS_ROW).first();
    await expect(row.locator('.loop-row-time')).toHaveText('0:03-0:08');

    await row.locator('.loop-row-shrink').click();
    await expect(row.locator('.loop-row-time')).toHaveText('0:03-0:05');
    await closeSheet(page);

    // The trimmed loop stays engaged as the current loop.
    await expectLoopStatus(page, 'Loop 0:03-0:05');

    const request = page.context().request;
    const headers = await authHeaders(request);
    const songs = await (await request.get('/api/songs', { headers })).json();
    const songId = (Array.isArray(songs) ? songs : songs.songs)[0].id;
    const loops = await (await request.get(`/api/songs/${songId}/loops`, { headers })).json();
    expect(loops).toHaveLength(1);
    expect(loops[0].startTime).toBeCloseTo(3.0);
    expect(loops[0].endTime).toBeCloseTo(5.0);
  });

  test('extend button grows the earlier loop onto the next note between loops, even when already played', async ({
    page,
  }) => {
    await startGame(page, {
      keepSong: true,
      songTitle: 'ExtendLoopBetween',
      notes: [
        { time: 5.0, key: 'C3', duration: 0.25 },
        { time: 6.0, key: 'E3', duration: 0.25 },
        { time: 8.0, key: 'G3', duration: 0.25 },
        { time: 11.0, key: 'A3', duration: 0.25 },
        { time: 12.0, key: 'B3', duration: 0.25 },
        { time: 13.0, key: 'C4', duration: 0.25 },
        { time: 14.0, key: 'D4', duration: 0.25 },
      ],
      loops: [
        { startTime: 10.0, endTime: 15.0, enabled: true },
        { startTime: 5.0, endTime: 7.0, enabled: true },
      ],
    });
    await closeSongInfoPopup(page);

    // The player already covered the note at 8s (between the two loops);
    // resolving it must not make the extend skip over it.
    const resolved = await page.evaluate(async (H) => {
      // @ts-expect-error browser-side dynamic import
      const { NOTE_TO_LANE } = await import('/js/utils/notes.js');
      const g = (window as any)._game;
      g.pause();
      const nm = g.noteManager;
      nm.update(8.0, H);
      const hit = nm.checkHit(8.0, NOTE_TO_LANE.get('G3'));
      return { resolved: nm.notes.find((n: any) => n.time === 8.0).resolved, hit: hit !== null };
    }, CANVAS_HEIGHT);
    expect(resolved.hit).toBe(true);
    expect(resolved.resolved).toBe(true);

    await openSheet(page);
    // Rows are in start order: the 5-7 loop is first, the 10-15 loop second.
    const row = page.locator(LOOPS_ROW).first();
    await expect(row.locator('.loop-row-time')).toHaveText('0:05-0:07');

    // The note at 8s is free of any loop: the loop extends onto it.
    await row.locator('.loop-row-extend').click();
    await expect(row.locator('.loop-row-time')).toHaveText('0:05-0:08');

    // The next note (11s) lies inside the 10-15 loop, so the loop grows
    // to that loop's start and sits adjacent instead of reaching into it.
    await row.locator('.loop-row-extend').click();
    await expect(row.locator('.loop-row-time')).toHaveText('0:05-0:10');

    // Already adjacent: further extends are a no-op.
    await row.locator('.loop-row-extend').click();
    await expect(row.locator('.loop-row-time')).toHaveText('0:05-0:10');
    await closeSheet(page);

    const request = page.context().request;
    const headers = await authHeaders(request);
    const songs = await (await request.get('/api/songs', { headers })).json();
    const songId = (Array.isArray(songs) ? songs : songs.songs)[0].id;
    const loops = await (await request.get(`/api/songs/${songId}/loops`, { headers })).json();
    expect(loops).toHaveLength(2);
    expect(loops[0].startTime).toBeCloseTo(5.0);
    expect(loops[0].endTime).toBeCloseTo(10.0);
    expect(loops[1].startTime).toBeCloseTo(10.0);
    expect(loops[1].endTime).toBeCloseTo(15.0);
  });
});
