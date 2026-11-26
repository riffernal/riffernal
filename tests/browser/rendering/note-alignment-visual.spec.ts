import { expect, test } from '@playwright/test';
import { CANVAS_HEIGHT, CANVAS_WIDTH, makeSong } from '../../helpers/index.js';

function indent(code: string, spaces: number): string {
  if (!code) return code;
  const pad = ' '.repeat(spaces);
  return code
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

// Shared in-browser scaffold: builds an offscreen Renderer at the test canvas
// size and measures drawn pixels against the background.
const RENDERER_SCAFFOLD = `
async function makeRenderer() {
  const { Renderer } = await import('/js/game/rendering/Renderer.js');
  const canvas = document.createElement('canvas');
  canvas.width = ${CANVAS_WIDTH}; canvas.height = ${CANVAS_HEIGHT};
  const r = new Renderer(canvas);
  r.width = ${CANVAS_WIDTH}; r.height = ${CANVAS_HEIGHT};
  r.canvas.width = ${CANVAS_WIDTH}; r.canvas.height = ${CANVAS_HEIGHT};
  r.ctx.setTransform(1, 0, 0, 1, 0, 0);
  return r;
}

// Horizontal extent of pixels differing from the background color inside
// the row band [yStart, yEnd] and the column window [xStart, xEnd).
function spanX(pixels, bg, xStart, xEnd, yStart, yEnd) {
  let minX = null, maxX = null;
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const i = (y * ${CANVAS_WIDTH} + x) * 4;
      const differs = Math.abs(pixels[i] - bg[0]) > 4
        || Math.abs(pixels[i + 1] - bg[1]) > 4
        || Math.abs(pixels[i + 2] - bg[2]) > 4;
      if (differs) {
        if (minX === null || x < minX) minX = x;
        if (maxX === null || x > maxX) maxX = x;
      }
    }
  }
  return { minX, maxX };
}`;

// -- chord head alignment ------------------------------------------------------

// Chord notes that differ only in duration must share one head bottom edge.
test('chord notes have heads at same vertical position', async ({ page }) => {
  await page.goto('/');

  const songJson = JSON.stringify(
    makeSong(
      [
        { time: 1.0, key: 'C3', duration: 0.05 },
        { time: 1.0, key: 'E3', duration: 0.5 },
        { time: 1.0, key: 'G3', duration: 1.0 },
      ],
      'Head Alignment Test',
    ),
  );

  const bottoms = (await page.evaluate(`(async () => {
    const { NoteManager } = await import('/js/game/NoteManager.js');
    const { getPianoKeyLayout } = await import('/js/utils/notes.js');
${indent(RENDERER_SCAFFOLD, 4)}

    const nm = new NoteManager();
    nm.loadSong(${songJson});
    const currentTime = 0.5;
    nm.update(currentTime, ${CANVAS_HEIGHT});
    const active = nm.getActiveNotes(currentTime, ${CANVAS_HEIGHT});

    const r = await makeRenderer();
    r.clear();
    for (const note of active) {
      r.drawNote(note.lane, note.y, note.height, note.color, note.alpha, 0, note.key);
    }

    // Lowest drawn pixel inside each note's key columns (scanning bottom-up).
    const pixels = r.ctx.getImageData(0, 0, ${CANVAS_WIDTH}, ${CANVAS_HEIGHT}).data;
    return active.map((n) => {
      const layout = getPianoKeyLayout(n.key, ${CANVAS_WIDTH});
      const xs = Math.floor(layout.x + 1), xe = Math.floor(layout.x + layout.width - 1);
      for (let y = ${CANVAS_HEIGHT - 1}; y >= 0; y--) {
        for (let x = xs; x < xe; x++) {
          const i = (y * ${CANVAS_WIDTH} + x) * 4;
          if (pixels[i + 3] > 10 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 40) return y;
        }
      }
      return null;
    });
  })()`)) as Array<number | null>;

  expect(bottoms.every((b) => b !== null)).toBe(true);
  expect(
    Math.max(...(bottoms as number[])) - Math.min(...(bottoms as number[])),
  ).toBeLessThanOrEqual(1.5);
});

// -- lane width ----------------------------------------------------------------

interface SpanMeasure {
  minX: number | null;
  maxX: number | null;
  keyX: number;
  keyW: number;
}

test('notes dock flush inside their key at the hit line', async ({ page }) => {
  await page.goto('/');

  const result = (await page.evaluate(`(async () => {
    const { getPianoKeyLayout } = await import('/js/utils/notes.js');
    const { HIT_ZONE_Y_RATIO } = await import('/js/game/NoteManager.js');
${indent(RENDERER_SCAFFOLD, 4)}

    const r = await makeRenderer();
    r.clear();
    const bg = r.ctx.getImageData(5, 5, 1, 1).data;
    const hitZoneY = ${CANVAS_HEIGHT} * HIT_ZONE_Y_RATIO;

    const measureDocked = (key) => {
      r.clear();
      // Head bottom exactly on the hit line: the note is fully docked.
      r.drawNote(0, hitZoneY - 100, 100, '#ff2222', 1, 0, key);
      const pixels = r.ctx.getImageData(0, 0, ${CANVAS_WIDTH}, ${CANVAS_HEIGHT}).data;
      const layout = getPianoKeyLayout(key, ${CANVAS_WIDTH});
      // Clean tail rows only: the name badge hugs the head below them.
      const span = spanX(pixels, bg,
        Math.floor(layout.x - 8), Math.ceil(layout.x + layout.width + 8),
        Math.floor(hitZoneY - 100), Math.floor(hitZoneY - 50));
      return { ...span, keyX: layout.x, keyW: layout.width };
    };

    return { white: measureDocked('C4'), black: measureDocked('C#4') };
  })()`)) as { white: SpanMeasure; black: SpanMeasure };

  for (const m of [result.white, result.black]) {
    expect(m.minX).not.toBeNull();
    expect(m.maxX).not.toBeNull();
    // Docks flush inside the key: within one snap-grid unit of each edge,
    // never spilling over the neighboring keys' indicator bars.
    expect(m.minX!).toBeGreaterThanOrEqual(m.keyX - 3);
    expect(m.maxX!).toBeLessThanOrEqual(m.keyX + m.keyW + 3);
    expect(m.maxX! - m.minX! + 1).toBeGreaterThanOrEqual(m.keyW * 0.75);
  }
});

test('up-screen notes keep most of their key width', async ({ page }) => {
  await page.goto('/');

  const result = (await page.evaluate(`(async () => {
    const { getPianoKeyLayout } = await import('/js/utils/notes.js');
${indent(RENDERER_SCAFFOLD, 4)}

    const r = await makeRenderer();
    r.clear();
    const bg = r.ctx.getImageData(5, 5, 1, 1).data;

    // Head bottom at 130 (t ~ 0): the smallest a note gets.
    r.drawNote(0, 30, 100, '#ff2222', 1, 0, 'C4');
    const pixels = r.ctx.getImageData(0, 0, ${CANVAS_WIDTH}, ${CANVAS_HEIGHT}).data;
    const layout = getPianoKeyLayout('C4', ${CANVAS_WIDTH});
    // Clean tail rows (note spans y 30..130; the head-hugging badge starts
    // around y 93): sample rows 55..85.
    const span = spanX(pixels, bg,
      Math.floor(layout.x - 8), Math.ceil(layout.x + layout.width + 8), 55, 85);
    return { ...span, keyW: layout.width };
  })()`)) as SpanMeasure;

  expect(result.minX).not.toBeNull();
  expect(result.maxX).not.toBeNull();
  // No narrow sticks: even at the top of the fall the note fills most of
  // its lane, matching the key it is falling toward.
  expect(result.maxX! - result.minX! + 1).toBeGreaterThanOrEqual(result.keyW * 0.7);
});

test('full standard notation expands the staff through the play area', async ({ page }) => {
  await page.goto('/');

  const layout = (await page.evaluate(`(async () => {
    const { Renderer } = await import('/js/game/rendering/Renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '${CANVAS_WIDTH}px';
    canvas.style.height = '${CANVAS_HEIGHT}px';
    document.body.appendChild(canvas);
    const renderer = new Renderer(canvas);
    const song = ${JSON.stringify(
      makeSong([{ time: 0.5, key: 'C4', duration: 0.25 }], 'Standard Notation Test'),
    )};
    const { NoteManager } = await import('/js/game/NoteManager.js');
    const notes = new NoteManager();
    notes.loadSong(song);
    renderer.setStandardNotation(true);
    renderer.drawSheetMusic(
      notes.trebleNotes,
      notes.bassNotes,
      0.5,
      notes.getSongDuration(),
      undefined,
      undefined,
      120,
      undefined,
    );
    return {
      standard: renderer.standardNotation,
      sheetHeight: renderer.sheetBottom - 84,
      sheetBottom: renderer.sheetBottom,
      pianoTop: renderer.height * 0.84,
      beatsVisible:
        (renderer.sheetViewEnd - renderer.sheetViewStart) / (60 / song.bpm),
      staffScale:
        (renderer.sheetTrebleBottom - renderer.sheetTrebleTop) / 40,
    };
  })()`)) as {
    standard: boolean;
    sheetHeight: number;
    sheetBottom: number;
    pianoTop: number;
    beatsVisible: number;
    staffScale: number;
  };

  expect(layout.standard).toBe(true);
  expect(layout.beatsVisible).toBeCloseTo(9, 1);
  expect(layout.staffScale).toBeLessThanOrEqual(3);
  expect(layout.staffScale).toBeGreaterThanOrEqual(2);
  expect(layout.sheetHeight).toBeGreaterThan(300);
  expect(layout.sheetBottom).toBeLessThanOrEqual(layout.pianoTop);
});

test('standard notation uses readable duration symbols and grand-staff spacing', async ({ page }) => {
  await page.goto('/');

  const result = (await page.evaluate(`(async () => {
    const { Renderer } = await import('/js/game/rendering/Renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '${CANVAS_WIDTH}px';
    canvas.style.height = '${CANVAS_HEIGHT}px';
    document.body.appendChild(canvas);
    const renderer = new Renderer(canvas);
    const durations = [2, 1, 0.5, 0.25, 0.125].map((duration) =>
      renderer._sheetDuration(duration, 2));
    const song = ${JSON.stringify(
      makeSong(
        [
          { time: 0.5, key: 'C3', duration: 0.5 },
          { time: 0.75, key: 'C#4', duration: 0.25 },
        ],
        'Duration Test',
      ),
    )};
    const { NoteManager } = await import('/js/game/NoteManager.js');
    const notes = new NoteManager();
    notes.loadSong(song);
    renderer.setStandardNotation(true);
    renderer.drawSheetMusic(notes.trebleNotes, notes.bassNotes, 0.5, notes.getSongDuration());
    return {
      durations,
      gap: renderer.sheetBassTop - renderer.sheetTrebleBottom,
    };
  })()`)) as {
    durations: Array<{
      beats: number;
      flags: number;
      hollow: boolean;
      dotted: boolean;
      whole: boolean;
    }>;
    gap: number;
  };

  expect(result.durations.map((duration) => duration.beats)).toEqual([4, 2, 1, 0.5, 0.25]);
  expect(result.durations[0].whole).toBe(true);
  expect(result.durations[1].hollow).toBe(true);
  expect(result.durations[3].flags).toBe(1);
  expect(result.durations[4].flags).toBe(2);
  expect(result.gap).toBeGreaterThanOrEqual(48);
});

test('staff pitch positions follow standard treble and bass reference lines', async ({ page }) => {
  await page.goto('/');

  const positions = (await page.evaluate(`(async () => {
    const { Renderer } = await import('/js/game/rendering/Renderer.js');
    const { NoteManager } = await import('/js/game/NoteManager.js');
    const { HandSide } = await import('/js/utils/notes.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '${CANVAS_WIDTH}px';
    canvas.style.height = '${CANVAS_HEIGHT}px';
    document.body.appendChild(canvas);
    const renderer = new Renderer(canvas);
    const song = ${JSON.stringify(
      makeSong(
        [
          { time: 0, key: 'A4', duration: 0.14 },
          { time: 0.14, key: 'F4', duration: 0.14 },
          { time: 0.28, key: 'E4', duration: 0.14 },
          { time: 0.42, key: 'D4', duration: 0.14 },
          { time: 0.42, key: 'G2', duration: 0.14 },
        ],
        'Pitch Position Test',
      ),
    )};
    const notes = new NoteManager();
    notes.loadSong(song);
    notes.notes[notes.notes.length - 1].hand = HandSide.Left;
    notes.trebleNotes = notes.notes.slice(0, 4);
    notes.bassNotes = [notes.notes[4]];
    renderer.drawSheetMusic(notes.trebleNotes, notes.bassNotes, 0, notes.getSongDuration());
    return notes.notes.map((note) => ({
      key: note.key,
      time: note.time,
      y: renderer.notePixelPosition(note).y,
    }));
  })()`)) as Array<{ key: string; time: number; y: number }>;

  expect(positions.map(({ key }) => key)).toEqual(['A4', 'F4', 'E4', 'D4', 'G2']);
  expect(positions[0].y).toBeLessThan(positions[1].y);
  expect(positions[1].y).toBeLessThan(positions[2].y);
  expect(positions[2].y).toBeLessThan(positions[3].y);
});
