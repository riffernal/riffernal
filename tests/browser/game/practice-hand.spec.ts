import { test, expect } from '@playwright/test';
import { makeSong, evaluateWithNoteManager, buildFreezeResumeScript } from '../../helpers/index.js';

// -- NoteManager unit tests --------------------------------------------------

test.describe('Practice Hand - NoteManager', () => {
  test('wide simultaneous dyads split between bass and treble staves', async ({ page }) => {
    await page.goto('/');
    const song = makeSong([
      { time: 0, key: 'A4', duration: 0.14 },
      { time: 40.14, key: 'D4', duration: 0.14 },
      { time: 40.14, key: 'D#5', duration: 0.14 },
    ]);
    song.tracks = [{ index: 0, name: 'Janne', noteCount: 3 }];
    song.selectedTrackIndices = [0];
    song.trackHands = { 0: 'right' };

    const result = await evaluateWithNoteManager(
      page,
      song,
      `return nm.notes.map((note) => ({ key: note.key, hand: note.hand }));`,
    );

    expect(result).toEqual([
      { key: 'A4', hand: 'right' },
      { key: 'D4', hand: 'left' },
      { key: 'D#5', hand: 'right' },
    ]);
  });
  test('getEarliestWaitTime skips non-practiced hand notes (left practice)', async ({ page }) => {
    await page.goto('/');
    const song = makeSong([
      { time: 1.0, key: 'C5', duration: 0.25 },
      { time: 2.0, key: 'C3', duration: 0.25 },
    ]);
    expect(
      await evaluateWithNoteManager(
        page,
        song,
        `
      const { PracticeHand } = await import('/js/utils/notes.js');
      nm.learningMode = true;
      nm.practiceHand = PracticeHand.Left;
      nm.update(1.0, H);
      const atRight = nm.getEarliestWaitTime(1.0);
      nm.update(2.0, H);
      const atLeft = nm.getEarliestWaitTime(2.0);
      return { atRight, atLeft };
    `,
      ),
    ).toEqual({ atRight: null, atLeft: 2.0 });
  });

  test('getEarliestWaitTime skips non-practiced hand notes (right practice)', async ({ page }) => {
    await page.goto('/');
    const song = makeSong([
      { time: 1.0, key: 'C3', duration: 0.25 },
      { time: 2.0, key: 'C5', duration: 0.25 },
    ]);
    expect(
      await evaluateWithNoteManager(
        page,
        song,
        `
      const { PracticeHand } = await import('/js/utils/notes.js');
      nm.learningMode = true;
      nm.practiceHand = PracticeHand.Right;
      nm.update(1.0, H);
      const atLeft = nm.getEarliestWaitTime(1.0);
      nm.update(2.0, H);
      const atRight = nm.getEarliestWaitTime(2.0);
      return { atLeft, atRight };
    `,
      ),
    ).toEqual({ atLeft: null, atRight: 2.0 });
  });

  test('auto-play tap note auto-resolves at note.time without scoring', async ({ page }) => {
    await page.goto('/');
    const song = makeSong([{ time: 1.0, key: 'C5', duration: 0.25 }]);
    const result = await evaluateWithNoteManager(
      page,
      song,
      `
      const { PracticeHand } = await import('/js/utils/notes.js');
      nm.learningMode = true;
      nm.practiceHand = PracticeHand.Left;
      nm.update(1.0, H);
      const note = nm.notes[0];
      return { autoPlayed: note.autoPlayed, hit: note.hit, resolved: note.resolved, score: nm.scoring.score };
    `,
    );
    expect(result.autoPlayed).toBe(true);
    expect(result.hit).toBe(true);
    expect(result.resolved).toBe(true);
    expect(result.score).toBe(0);
  });

  test('auto-play hold note triggers onAutoPlayOn and finalizes without scoring', async ({
    page,
  }) => {
    await page.goto('/');
    const song = makeSong([{ time: 1.0, key: 'C5', duration: 1.0 }]);
    const result = await evaluateWithNoteManager(
      page,
      song,
      `
      const { PracticeHand } = await import('/js/utils/notes.js');
      nm.learningMode = true;
      nm.practiceHand = PracticeHand.Left;
      let playedOn = 0;
      nm.onAutoPlayOn = () => { playedOn++; };
      nm.update(1.0, H);
      const afterStart = { playedOn, holding: nm.notes[0].holding, autoPlayed: nm.notes[0].autoPlayed };
      nm.update(2.0, H);
      const afterEnd = { playedOn, hit: nm.notes[0].hit, resolved: nm.notes[0].resolved, score: nm.scoring.score };
      return { afterStart, afterEnd };
    `,
    );
    expect(result.afterStart.playedOn).toBe(1);
    expect(result.afterStart.holding).toBe(true);
    expect(result.afterStart.autoPlayed).toBe(true);
    expect(result.afterEnd.playedOn).toBe(1);
    expect(result.afterEnd.hit).toBe(true);
    expect(result.afterEnd.resolved).toBe(true);
    expect(result.afterEnd.score).toBe(0);
  });

  test('no auto-play when practiceHand is Both', async ({ page }) => {
    await page.goto('/');
    const song = makeSong([{ time: 1.0, key: 'C5', duration: 0.25 }]);
    const result = await evaluateWithNoteManager(
      page,
      song,
      `
      const { PracticeHand } = await import('/js/utils/notes.js');
      nm.learningMode = true;
      nm.practiceHand = PracticeHand.Both;
      nm.update(1.0, H);
      return { autoPlayed: nm.notes[0].autoPlayed, hit: nm.notes[0].hit };
    `,
    );
    expect(result.autoPlayed).toBe(false);
    expect(result.hit).toBe(false);
  });

  test('no auto-play when learningMode is false (PLAY mode)', async ({ page }) => {
    await page.goto('/');
    const song = makeSong([{ time: 1.0, key: 'C5', duration: 0.25 }]);
    const result = await evaluateWithNoteManager(
      page,
      song,
      `
      const { PracticeHand } = await import('/js/utils/notes.js');
      nm.learningMode = false;
      nm.practiceHand = PracticeHand.Left;
      nm.update(1.0, H);
      return { autoPlayed: nm.notes[0].autoPlayed, hit: nm.notes[0].hit };
    `,
    );
    expect(result.autoPlayed).toBe(false);
    expect(result.hit).toBe(false);
  });

  test('checkLearningHit silently ignores auto-play lane press (not wrong)', async ({ page }) => {
    await page.goto('/');
    const song = makeSong([{ time: 1.0, key: 'C5', duration: 0.25 }]);
    const result = await evaluateWithNoteManager(
      page,
      song,
      `
      const { PracticeHand } = await import('/js/utils/notes.js');
      nm.learningMode = true;
      nm.practiceHand = PracticeHand.Left;
      nm.update(0.5, H);
      const lane = NOTE_TO_LANE.get('C5');
      const o = nm.checkLearningHit(0.5, lane);
      return { wrong: o.wrong, results: o.results.length };
    `,
    );
    expect(result.wrong).toBe(false);
    expect(result.results).toBe(0);
  });

  test('practiced hand note still freezes and registers hits normally', async ({ page }) => {
    await page.goto('/');
    const song = makeSong([{ time: 1.0, key: 'C3', duration: 0.25 }]);
    const result = await evaluateWithNoteManager(
      page,
      song,
      `
      const { PracticeHand } = await import('/js/utils/notes.js');
      nm.learningMode = true;
      nm.practiceHand = PracticeHand.Left;
      nm.update(1.0, H);
      const waitTime = nm.getEarliestWaitTime(1.0);
      const o = nm.checkLearningHit(1.0, NOTE_TO_LANE.get('C3'));
      return { waitTime, committed: o.results.length, hit: nm.notes[0].hit };
    `,
    );
    expect(result.waitTime).toBe(1.0);
    expect(result.committed).toBe(1);
    expect(result.hit).toBe(true);
  });
});

// -- integration: freeze resume only stops at practiced hand -----------------

test.describe('Practice Hand - freeze resume', () => {
  test('right-hand note auto-plays without freezing; left-hand note freezes', async ({ page }) => {
    test.setTimeout(15000);
    const songJson = JSON.stringify(
      makeSong(
        [
          { time: 0.5, key: 'C5', duration: 0.25 },
          { time: 3.0, key: 'C3', duration: 0.25 },
        ],
        'PracticeLeft',
      ),
    );

    await page.goto('/');

    const result = (await page.evaluate(
      buildFreezeResumeScript(
        songJson,
        `
      const { PracticeHand } = await import('/js/utils/notes.js');
      game.setPracticeHand(PracticeHand.Left);
      await new Promise(r => setTimeout(r, 1200));
      const rightAutoPlayed = game.noteManager.notes[0].autoPlayed;
      const leftFailing = game.noteManager.notes[1].failing;
      const leftMissed = game.noteManager.notes[1].missed;
      return { frozenTime: game.currentTime, rightAutoPlayed, leftFailing, leftMissed };
    `,
      ),
    )) as {
      frozenTime: number;
      rightAutoPlayed: boolean;
      leftFailing: boolean;
      leftMissed: boolean;
    };

    expect(result.frozenTime).toBeLessThan(3.0);
    expect(result.rightAutoPlayed).toBe(true);
    expect(result.leftFailing).toBe(false);
    expect(result.leftMissed).toBe(false);
  });

  test('switching practiceHand during freeze rebuilds chord lanes', async ({ page }) => {
    test.setTimeout(15000);
    const songJson = JSON.stringify(
      makeSong(
        [
          { time: 0.5, key: 'C#4', duration: 1.499 },
          { time: 0.5, key: 'E4', duration: 1.499 },
          { time: 0.5, key: 'A2', duration: 1.999 },
          { time: 0.5, key: 'A3', duration: 1.999 },
          { time: 5.0, key: 'E4', duration: 0.25 },
        ],
        'Clockwork',
      ),
    );

    await page.goto('/');

    const result = (await page.evaluate(
      buildFreezeResumeScript(
        songJson,
        `
      const { PracticeHand } = await import('/js/utils/notes.js');
      const { NOTE_TO_LANE } = await import('/js/utils/notes.js');
      const laneToKey = new Map([...NOTE_TO_LANE].map(([k, v]) => [v, k]));
      const beforeLanes = [...game.noteManager._learningChordLanes].map(l => laneToKey.get(l));
      game.setPracticeHand(PracticeHand.Right);
      await new Promise(r => setTimeout(r, 200));
      const afterLanes = [...game.noteManager._learningChordLanes].map(l => laneToKey.get(l));
      const autoPlayed = game.noteManager.notes.slice(0, 4).map(n => ({ key: n.key, autoPlayed: n.autoPlayed }));
      game._handleNoteOn('C#4', 't1');
      game._handleNoteOn('E4', 't2');
      await new Promise(r => setTimeout(r, 300));
      const afterPress = {
        currentTime: game.currentTime,
        rightHolding: [0, 1].every(i => game.noteManager.notes[i].holding),
      };
      return { beforeLanes, afterLanes, autoPlayed, afterPress };
    `,
      ),
    )) as {
      frozenTime: number;
      beforeLanes: string[];
      afterLanes: string[];
      autoPlayed: { key: string; autoPlayed: boolean }[];
      afterPress: { currentTime: number; rightHolding: boolean };
    };

    expect(result.beforeLanes).toHaveLength(4);
    expect(result.beforeLanes).toEqual(expect.arrayContaining(['C#4', 'E4', 'A2', 'A3']));
    expect(result.afterLanes).toHaveLength(2);
    expect(result.afterLanes).not.toContain('A2');
    expect(result.afterLanes).not.toContain('A3');
    expect(result.afterLanes).toEqual(expect.arrayContaining(['C#4', 'E4']));
    expect(result.autoPlayed).toEqual([
      { key: 'C#4', autoPlayed: false },
      { key: 'E4', autoPlayed: false },
      { key: 'A2', autoPlayed: true },
      { key: 'A3', autoPlayed: true },
    ]);
    expect(result.afterPress.rightHolding).toBe(true);
    expect(result.afterPress.currentTime).toBeGreaterThan(result.frozenTime);
  });
});
