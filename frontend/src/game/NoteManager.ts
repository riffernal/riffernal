// Manages note state, timing, hit detection, and learning mode.
// Tracks active notes, handles press/release events, and resolves
// notes based on timing windows and scoring rules.

import {
  NOTE_TO_LANE,
  pitchClassForLane,
  handForKey,
  handColor,
  HandSide,
  PracticeHand,
} from '../utils/notes.js';
import type { Song, Note } from '../utils/MidiParser.js';
import type { Renderer } from './rendering/Renderer.js';
import {
  Scoring,
  TIMING,
  TAP_NOTE_THRESHOLD,
  EARLY_HIT_WINDOW,
  EARLY_PENALTY_RATIO,
  LEARNING_CHORD_WINDOW,
  gradeFromDiff,
  NoteGrade,
} from './scoring.js';

export const SCROLL_SPEED = 400;

export const HIT_ZONE_Y_RATIO = 0.82;

/** How far ahead of its audible time a background voice is built on the
 *  audio clock. Spreads voice creation across frames so dense multi-track
 *  passages never burst synth graphs into a single late frame. */
const AUTO_SCHEDULE_AHEAD = 0.2;

/** Safety margin for the time-window pre-filter in `findNearestNoteByClick`.
 *  1.5× ensures notes slightly beyond the exact pixel radius are still
 *  considered, accounting for stem/flag overshoot and rounding. */
const CLICK_TIME_WINDOW_RATIO = 1.5;

export interface LearningHitOutcome {
  results: HitResult[];
  wrong: boolean;
}

export interface SongNote extends Note {
  hit: boolean;
  missed: boolean;
  lane: number;
  pitchClass: string;
  holding: boolean;
  pressStartTime: number;
  failing: boolean;
  grade: NoteGrade | null;
  earnedScore: number;
  resolved: boolean;
  activated: boolean;
  accumulatedHeldDuration: number;
  earlyMultiplier: number;
  autoPlayed: boolean;
  audioScheduled: boolean;
  track: number;
  hand: HandSide;
  selected: boolean;
  channel: number;
  rawMidi: number;
  program: number;
  hitOffsetMs: number;
}

export interface ActiveNoteRender {
  lane: number;
  y: number;
  height: number;
  color: string;
  alpha: number;
  duration: number;
  key: string;
  holding: boolean;
  waiting: boolean;
  selected: boolean;
}

export interface HitResult {
  note: SongNote;
  result: NoteGrade;
  offsetMs: number;
}

export interface ReleaseResult {
  note: SongNote;
  penalty: number;
  holdRatio: number;
  grade: NoteGrade;
}

export interface ResolveResult {
  note: SongNote;
  score: number;
  grade: NoteGrade | null;
  offsetMs: number;
}

export class NoteManager {
  scoring = new Scoring();
  notes: SongNote[] = [];
  activeNotes: SongNote[] = [];
  trebleNotes: SongNote[] = [];
  bassNotes: SongNote[] = [];
  onMiss: ((note: SongNote) => void) | null = null;
  onResolve: ((result: ResolveResult) => void) | null = null;
  onAutoPlayOn: ((note: SongNote) => void) | null = null;
  onAutoPlaySchedule: ((note: SongNote) => void) | null = null;
  learningMode = false;
  practiceHand: PracticeHand = PracticeHand.Both;
  private _nextNoteIndex = 0;
  private _selectedNoteCount = 0;
  private _selectedResolvedCount = 0;
  private _learningAnchor: number | null = null;
  private _learningChordLanes = new Set<number>();
  private _learningChordPresses = new Set<number>();
  private _learningChordFirstPressRealTime = 0;
  private _laneHand = new Map<number, HandSide>();
  backgroundTracks = new Set<number>();
  private _notePool: ActiveNoteRender[] = [];
  private _noteEndMax: number[] = [];

  loadSong(songData: Song): void {
    const selectedIndices = songData.selectedTrackIndices ?? [];
    const trackHands = songData.trackHands ?? {};
    const hasTrackInfo = songData.tracks && songData.tracks.length > 0;

    this.backgroundTracks = new Set(songData.backgroundTracks ?? []);

    this.notes = songData.notes
      .map((n: Note) => {
        const track = n.track ?? 0;
        const hand = trackHands[track] ?? handForKey(n.key);
        const selected = hasTrackInfo
          ? selectedIndices.length === 0 || selectedIndices.includes(track)
          : true;
        return {
          ...n,
          hit: false,
          missed: false,
          lane: NOTE_TO_LANE.get(n.key) ?? -1,
          pitchClass: n.key.replace(/\d/g, ''),
          holding: false,
          pressStartTime: 0,
          failing: false,
          grade: null,
          earnedScore: 0,
          resolved: false,
          activated: false,
          accumulatedHeldDuration: 0,
          earlyMultiplier: 1,
          autoPlayed: false,
          audioScheduled: false,
          track,
          hand,
          selected,
          channel: n.channel ?? 0,
          rawMidi: n.rawMidi ?? 0,
          program: n.program ?? -1,
          hitOffsetMs: 0,
        };
      })
      .sort((a, b) => a.time - b.time);
    this._assignChordHands();
    this._noteEndMax = new Array(this.notes.length);
    let maxEnd = 0;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time + n.duration > maxEnd) maxEnd = n.time + n.duration;
      this._noteEndMax[i] = maxEnd;
    }
    this.activeNotes = [];
    this._nextNoteIndex = 0;
    this._selectedNoteCount = this.notes.filter((n) => n.selected).length;
    this._selectedResolvedCount = 0;
    this.scoring.reset(this._selectedNoteCount);
    this.resetLearningState();
    this.trebleNotes = [];
    this.bassNotes = [];
    this._laneHand.clear();
    for (const note of this.notes) {
      if (!note.selected) continue;
      if (note.hand === HandSide.Left) {
        this.bassNotes.push(note);
      } else {
        this.trebleNotes.push(note);
      }
      if (!this._laneHand.has(note.lane)) {
        this._laneHand.set(note.lane, note.hand);
      }
    }
  }

  private _assignChordHands(): void {
    let start = 0;

    while (start < this.notes.length) {
      let end = start + 1;

      while (
        end < this.notes.length &&
        this.notes[end].track === this.notes[start].track &&
        Math.abs(this.notes[end].time - this.notes[start].time) < 0.001
      ) {
        end++;
      }

      const chord = this.notes.slice(start, end).sort((a, b) => a.lane - b.lane);

      if (chord.length === 2) {
        const gap = chord[1].lane - chord[0].lane;
        const lower = chord[0].lane;
        const upper = chord[1].lane;
        const C4 = NOTE_TO_LANE.get('C4')!;
        const E4 = NOTE_TO_LANE.get('E4')!;

        if (gap >= 12 && upper >= C4 && lower <= E4) {
          chord[0].hand = HandSide.Left;
          chord[1].hand = HandSide.Right;
        }
      }

      start = end;
    }
  }

  private _isAutoPlayNote(note: SongNote): boolean {
    if (!note.selected) return this.backgroundTracks.has(note.track);
    if (!this.learningMode || this.practiceHand === PracticeHand.Both) return false;
    const hand = note.hand;
    if (this.practiceHand === PracticeHand.Left) return hand === HandSide.Right;
    return hand === HandSide.Left;
  }

  /** True for notes the player must play: selected (not a background
   *  track) and not auto-played for the current practice hand. */
  private _isPlayerNote(note: SongNote): boolean {
    return note.selected && !this._isAutoPlayNote(note);
  }

  /** Mark a note as resolved and keep the selected-resolved counter in sync.
   *  Safe to call when already resolved (no-op). */
  private _markResolved(note: SongNote): void {
    if (note.resolved) return;
    note.resolved = true;
    if (note.selected) this._selectedResolvedCount++;
  }

  resetLearningState(): void {
    this._learningAnchor = null;
    this._learningChordLanes.clear();
    this._learningChordPresses.clear();
    this._learningChordFirstPressRealTime = 0;
  }

  setBackgroundTrack(trackIndex: number, enabled: boolean): void {
    if (enabled) {
      this.backgroundTracks.add(trackIndex);
    } else {
      this.backgroundTracks.delete(trackIndex);
    }
  }

  /** Reset gameplay state for all notes at or after `time` so a seek/loop
   *  rewind can replay them. Notes strictly before `time` that were not yet
   *  played are marked as resolved (skipped) so learning mode does not freeze
   *  waiting on them after a forward seek. Already-played earlier notes
   *  preserve their hit/grade state. Scoring is preserved cumulatively. */
  resetFromTime(time: number): void {
    for (const note of this.notes) {
      if (note.time < time) {
        // Notes before the seek target are skipped: mark them as resolved so
        // learning mode does not freeze waiting on them. Preserve any earned
        // hit/grade state for notes that were actually played before the seek.
        if (!note.resolved) {
          note.resolved = true;
          note.activated = true;
          note.missed = false;
        }
        continue;
      }
      note.hit = false;
      note.missed = false;
      note.holding = false;
      note.pressStartTime = 0;
      note.failing = false;
      note.grade = null;
      note.earnedScore = 0;
      note.resolved = false;
      note.activated = false;
      note.accumulatedHeldDuration = 0;
      note.earlyMultiplier = 1;
      note.autoPlayed = false;
      note.audioScheduled = false;
      note.hitOffsetMs = 0;
    }
    this.activeNotes = [];
    let firstUnresolved = 0;
    while (firstUnresolved < this.notes.length && this.notes[firstUnresolved].resolved) {
      firstUnresolved++;
    }
    this._nextNoteIndex = firstUnresolved;
    this._selectedResolvedCount = this.notes.reduce(
      (acc, n) => acc + (n.selected && n.resolved ? 1 : 0),
      0,
    );
    this.resetLearningState();
  }

  /** Advance note gameplay state to `currentTime`: auto-plays non-practiced
   *  notes, resolves completed holds and failures, marks missed notes,
   *  activates notes entering the hittable window, then prunes the active
   *  render list. */
  update(currentTime: number, height: number, loopEndCutoff: number | null = null): void {
    const hitZoneY = height * HIT_ZONE_Y_RATIO;
    const lookAhead = hitZoneY / SCROLL_SPEED;

    this._skipResolvedNotes();
    this._advanceNoteStates(currentTime, lookAhead, loopEndCutoff);
    this._pruneActiveNotes(currentTime, hitZoneY, height);
  }

  private _skipResolvedNotes(): void {
    while (this._nextNoteIndex < this.notes.length && this.notes[this._nextNoteIndex].resolved) {
      this._nextNoteIndex++;
    }
  }

  private _advanceNoteStates(
    currentTime: number,
    lookAhead: number,
    loopEndCutoff: number | null,
  ): void {
    for (let i = this._nextNoteIndex; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.resolved) {
        continue;
      }

      // When a loop is active, suppress activation/auto-play/miss of any note
      // whose start is past the loop end. Notes are sorted by time, so once
      // one is past the cutoff every later note is too — break out. Notes
      // already holding/failing from inside the loop still drain below.
      if (loopEndCutoff !== null && note.time > loopEndCutoff && !note.holding && !note.failing) {
        break;
      }

      const timeDiff = note.time - currentTime;

      // Notes far in the future can't be activated, missed, or auto-played.
      // Since notes are sorted by time, all subsequent notes are even further
      // ahead, so we can stop scanning.
      if (timeDiff > lookAhead + 1) {
        break;
      }

      if (this._resolveAutoPlayNote(note, timeDiff, currentTime)) continue;

      if (note.holding) {
        this._finishHold(note, currentTime);
        continue;
      }

      if (note.failing) {
        this._finishFailingNote(note, currentTime);
        continue;
      }

      if (timeDiff < -TIMING.GOOD) {
        this._expireNote(note);
        continue;
      }

      this._activateNote(note, timeDiff, lookAhead);
    }
  }

  /** Auto-played notes (background tracks / non-practiced hand) resolve
   *  themselves on schedule. Returns true when the note was handled and the
   *  scan should move on. */
  private _resolveAutoPlayNote(note: SongNote, timeDiff: number, currentTime: number): boolean {
    if (!this._isAutoPlayNote(note) || note.autoPlayed) return false;

    // Hand the voice to the synth slightly before it is due, scheduled on
    // the audio clock. Learned-mode freeze holds the clock, so ahead-of-time
    // scheduling must wait until the wait resolves to keep accompaniment in
    // sync with the player.
    const waitingFrozen =
      this.learningMode && this._learningAnchor !== null && currentTime === this._learningAnchor;

    if (!note.audioScheduled && !waitingFrozen && timeDiff <= AUTO_SCHEDULE_AHEAD) {
      note.audioScheduled = true;
      if (this.onAutoPlaySchedule) this.onAutoPlaySchedule(note);
    }

    if (timeDiff > 0) return false;

    note.autoPlayed = true;
    if (this.onAutoPlayOn) this.onAutoPlayOn(note);
    if (note.duration <= TAP_NOTE_THRESHOLD) {
      note.hit = true;
      note.holding = false;
      this._markResolved(note);
    } else {
      note.holding = true;
      note.pressStartTime = note.time;
    }
    return true;
  }

  /** Resolve a held note that has reached the end of its duration. */
  private _finishHold(note: SongNote, currentTime: number): void {
    if (currentTime < note.time + note.duration) return;

    const noteEnd = note.time + note.duration;
    const finalSegment = noteEnd - note.pressStartTime;
    note.accumulatedHeldDuration += Math.max(0, finalSegment);
    note.accumulatedHeldDuration = Math.min(note.accumulatedHeldDuration, note.duration);
    const cumulativeRatio = note.accumulatedHeldDuration / note.duration;
    note.hit = true;
    note.holding = false;
    this._markResolved(note);
    if (!note.autoPlayed) {
      note.earnedScore = this.scoring.finalizeNote(
        note.grade!,
        cumulativeRatio,
        note.earlyMultiplier,
      );
      if (this.onResolve)
        this.onResolve({
          note,
          score: note.earnedScore,
          grade: note.grade!,
          offsetMs: note.hitOffsetMs,
        });
    }
  }

  /** Resolve a failing (dropped hold) note at the end of its duration. */
  private _finishFailingNote(note: SongNote, currentTime: number): void {
    if (currentTime < note.time + note.duration) return;

    this._markResolved(note);
    if (note.accumulatedHeldDuration > 0 && note.grade !== null) {
      const cumulativeRatio = note.accumulatedHeldDuration / note.duration;
      note.earnedScore = this.scoring.finalizeNote(
        note.grade,
        cumulativeRatio,
        note.earlyMultiplier,
      );
      if (this.onResolve)
        this.onResolve({
          note,
          score: note.earnedScore,
          grade: note.grade,
          offsetMs: note.hitOffsetMs,
        });
    } else {
      this.scoring.finalizeNote(null, 0);
      if (this.onResolve) this.onResolve({ note, score: 0, grade: null, offsetMs: 0 });
    }
  }

  /** A note whose GOOD window has passed: missed when player-tracked,
   *  silently skipped otherwise. */
  private _expireNote(note: SongNote): void {
    if (note.selected) {
      note.missed = true;
      note.failing = true;
      if (this.onMiss) this.onMiss(note);
    } else {
      this._markResolved(note);
    }
  }

  private _activateNote(note: SongNote, timeDiff: number, lookAhead: number): void {
    if (timeDiff > lookAhead || note.activated) return;

    note.activated = true;
    if (note.selected) {
      this.activeNotes.push(note);
    }
  }

  /** Drop resolved and fully-scrolled-off notes from the active render list. */
  private _pruneActiveNotes(currentTime: number, hitZoneY: number, height: number): void {
    let writeIdx = 0;
    for (let i = 0; i < this.activeNotes.length; i++) {
      const n = this.activeNotes[i];
      if ((n.hit || n.missed) && !n.failing) continue;
      const noteHeight = Math.max(12, n.duration * SCROLL_SPEED);
      const y = hitZoneY - (n.time - currentTime) * SCROLL_SPEED - noteHeight;
      if (y >= height + 50) continue;
      this.activeNotes[writeIdx++] = n;
    }
    this.activeNotes.length = writeIdx;
  }

  /** `pressOffsetMs` overrides the game-time offset when the caller has a
   *  more accurate real-time measurement (learn mode, where game time is
   *  frozen at the note). Null falls back to `currentTime - note.time`. */
  checkHit(
    currentTime: number,
    lane: number,
    octaveAgnostic = false,
    pressOffsetMs: number | null = null,
  ): HitResult | null {
    const result =
      this._tryRecoverFailingNote(currentTime, lane, octaveAgnostic) ??
      this._tryNormalHit(currentTime, lane, octaveAgnostic, pressOffsetMs);
    if (result === null && !this.hasUnresolvedNoteInLane(lane, currentTime, octaveAgnostic)) {
      this.scoring.recordWrongPress();
    }
    return result;
  }

  /** Returns true if there is an unresolved note in the given lane within
   *  the hittable window of `currentTime`. Pressing a key for a note beyond
   *  that is a wrong key press. */
  hasUnresolvedNoteInLane(lane: number, currentTime: number, octaveAgnostic = false): boolean {
    const targetPitchClass = octaveAgnostic ? pitchClassForLane(lane) : '';
    return this.activeNotes.some(
      (n) =>
        this._noteMatchesLane(n, lane, octaveAgnostic, targetPitchClass) &&
        !n.resolved &&
        Math.abs(n.time - currentTime) <= TIMING.GOOD,
    );
  }

  private _beginHold(note: SongNote, currentTime: number): void {
    note.holding = true;
    note.pressStartTime = currentTime;
  }

  private _resolveTapNote(note: SongNote, grade: NoteGrade, ratio: number): void {
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    note.hit = true;
    note.holding = false;
    this._markResolved(note);
    note.earnedScore = this.scoring.finalizeNote(grade, clampedRatio, note.earlyMultiplier);
    if (this.onResolve)
      this.onResolve({
        note,
        score: note.earnedScore,
        grade,
        offsetMs: note.hitOffsetMs,
      });
  }

  private _tryRecoverFailingNote(
    currentTime: number,
    lane: number,
    octaveAgnostic = false,
  ): HitResult | null {
    const targetPitchClass = octaveAgnostic ? pitchClassForLane(lane) : '';
    for (const note of this.activeNotes) {
      if (!note.failing || note.holding || note.resolved) continue;
      if (!this._noteMatchesLane(note, lane, octaveAgnostic, targetPitchClass)) continue;

      const noteEnd = note.time + note.duration;
      if (currentTime >= noteEnd) continue;

      // Don't recover an old failing note if a fresher un-hit note in the same
      // lane is within the timing window — let _tryNormalHit handle the new note.
      // Fixes consecutive same-note sequences (e.g. C3 C3) where re-pressing the
      // key for the second note would otherwise recover the first note instead.
      const hasFreshNote = this.activeNotes.some(
        (n) =>
          n !== note &&
          this._noteMatchesLane(n, lane, octaveAgnostic, targetPitchClass) &&
          !n.hit &&
          !n.missed &&
          !n.holding &&
          !n.failing &&
          !n.resolved &&
          !this._isAutoPlayNote(n) &&
          Math.abs(n.time - currentTime) <= TIMING.GOOD + EARLY_HIT_WINDOW,
      );
      if (hasFreshNote) continue;

      const isRepress = note.accumulatedHeldDuration > 0;
      const grade = isRepress ? note.grade! : NoteGrade.GOOD;

      if (!isRepress) {
        this.scoring.recordNotePress();
        note.grade = grade;
      }

      note.failing = false;
      note.missed = false;
      this._beginHold(note, currentTime);

      if (note.duration <= TAP_NOTE_THRESHOLD) {
        this._resolveTapNote(note, grade, (noteEnd - currentTime) / note.duration);
      }

      return { note, result: grade, offsetMs: note.hitOffsetMs };
    }
    return null;
  }

  private _tryNormalHit(
    currentTime: number,
    lane: number,
    octaveAgnostic = false,
    pressOffsetMs: number | null = null,
  ): HitResult | null {
    let bestNote: SongNote | null = null;
    let bestDiff = Infinity;
    let isEarlyHit = false;
    const targetPitchClass = octaveAgnostic ? pitchClassForLane(lane) : '';

    for (const note of this.activeNotes) {
      if (note.hit || note.missed || note.holding || note.failing) continue;
      if (!this._noteMatchesLane(note, lane, octaveAgnostic, targetPitchClass)) continue;
      if (this._isAutoPlayNote(note)) continue;
      const diff = Math.abs(note.time - currentTime);
      const isEarly = currentTime < note.time;
      const maxWindow = isEarly ? TIMING.GOOD + EARLY_HIT_WINDOW : TIMING.GOOD;
      if (diff < bestDiff && diff <= maxWindow) {
        bestDiff = diff;
        bestNote = note;
        isEarlyHit = isEarly && diff > TIMING.GOOD;
      }
    }

    if (!bestNote) return null;

    const grade = isEarlyHit ? NoteGrade.GOOD : gradeFromDiff(bestDiff);
    if (isEarlyHit) bestNote.earlyMultiplier = EARLY_PENALTY_RATIO;

    this.scoring.recordNotePress();
    bestNote.grade = grade;

    const offsetMs = pressOffsetMs ?? Math.round((currentTime - bestNote.time) * 1000);
    bestNote.hitOffsetMs = offsetMs;
    this.scoring.recordOffset(offsetMs);

    if (bestNote.duration <= TAP_NOTE_THRESHOLD) {
      this._resolveTapNote(bestNote, grade, 1);
    } else {
      this._beginHold(bestNote, currentTime);
    }

    return { note: bestNote, result: grade, offsetMs };
  }

  checkRelease(currentTime: number, lane: number, octaveAgnostic = false): ReleaseResult | null {
    let holdingNote: SongNote | null = null;
    const targetPitchClass = octaveAgnostic ? pitchClassForLane(lane) : '';
    for (const note of this.activeNotes) {
      if (note.holding && this._noteMatchesLane(note, lane, octaveAgnostic, targetPitchClass)) {
        if (note.autoPlayed) return null;
        holdingNote = note;
        break;
      }
    }

    if (!holdingNote) return null;

    const segmentDuration = currentTime - holdingNote.pressStartTime;
    holdingNote.accumulatedHeldDuration += Math.max(0, segmentDuration);
    const cumulativeRatio = Math.min(
      1,
      Math.max(0, holdingNote.accumulatedHeldDuration / holdingNote.duration),
    );

    if (cumulativeRatio >= 1) {
      holdingNote.hit = true;
      holdingNote.holding = false;
      this._markResolved(holdingNote);
      holdingNote.earnedScore = this.scoring.finalizeNote(
        holdingNote.grade!,
        cumulativeRatio,
        holdingNote.earlyMultiplier,
      );
      if (this.onResolve)
        this.onResolve({
          note: holdingNote,
          score: holdingNote.earnedScore,
          grade: holdingNote.grade!,
          offsetMs: holdingNote.hitOffsetMs,
        });
      return null;
    }

    holdingNote.failing = true;
    holdingNote.holding = false;

    return {
      note: holdingNote,
      penalty: 0,
      holdRatio: cumulativeRatio,
      grade: holdingNote.grade!,
    };
  }

  private _isAutoPlayLane(lane: number, octaveAgnostic = false): boolean {
    const targetPitchClass = octaveAgnostic ? pitchClassForLane(lane) : '';
    return this.activeNotes.some(
      (n) =>
        this._noteMatchesLane(n, lane, octaveAgnostic, targetPitchClass) &&
        !n.resolved &&
        this._isAutoPlayNote(n),
    );
  }

  private _noteMatchesLane(
    note: SongNote,
    lane: number,
    octaveAgnostic: boolean,
    targetPitchClass: string,
  ): boolean {
    return octaveAgnostic ? note.pitchClass === targetPitchClass : note.lane === lane;
  }

  private _hasPlayableNote(
    currentTime: number,
    lane: number,
    octaveAgnostic: boolean,
    targetPitchClass: string,
  ): boolean {
    return this.activeNotes.some(
      (n) =>
        this._noteMatchesLane(n, lane, octaveAgnostic, targetPitchClass) &&
        !n.hit &&
        !n.missed &&
        !n.holding &&
        !n.failing &&
        !n.resolved &&
        !this._isAutoPlayNote(n) &&
        Math.abs(n.time - currentTime) <= TIMING.GOOD,
    );
  }

  private _learningChordLanesHasPitchClass(targetPitchClass: string): boolean {
    for (const chordLane of this._learningChordLanes) {
      if (pitchClassForLane(chordLane) === targetPitchClass) return true;
    }
    return false;
  }

  getEarliestWaitTime(rawTime: number, loopEndCutoff: number | null = null): number | null {
    if (this._learningAnchor !== null) {
      let allEngaged = true;
      for (let i = this._nextNoteIndex; i < this.notes.length; i++) {
        const note = this.notes[i];
        if (note.time > this._learningAnchor) break;
        if (!this._isPlayerNote(note)) continue;
        if (note.resolved || note.holding || note.failing || note.hit) continue;
        allEngaged = false;
        break;
      }
      if (allEngaged) {
        this._learningAnchor = null;
        this._learningChordLanes.clear();
        this._learningChordPresses.clear();
        this._learningChordFirstPressRealTime = 0;
      } else {
        return this._learningAnchor;
      }
    }

    for (let i = this._nextNoteIndex; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.resolved || note.holding || note.failing || note.hit) continue;
      if (!this._isPlayerNote(note)) continue;
      // With an active loop, never freeze on a note past the loop end:
      // the loop wrap will rewind once the in-loop tail finishes, so let
      // currentTime advance through that tail-out window.
      if (loopEndCutoff !== null && note.time > loopEndCutoff) return null;
      if (note.time <= rawTime) {
        this._learningAnchor = note.time;
        this._learningChordLanes.clear();
        this._learningChordPresses.clear();
        this._learningChordFirstPressRealTime = 0;
        for (let j = i; j < this.notes.length; j++) {
          const n = this.notes[j];
          if (n.time > this._learningAnchor) break;
          if (n.resolved || n.holding || n.failing || n.hit) continue;
          if (!this._isPlayerNote(n)) continue;
          this._learningChordLanes.add(n.lane);
        }
        return note.time;
      }
      return null;
    }
    return null;
  }

  checkLearningHit(
    currentTime: number,
    lane: number,
    realTime: number = performance.now(),
    octaveAgnostic = false,
    pressOffsetMs: number | null = null,
  ): LearningHitOutcome {
    const recoverResult = this._tryRecoverFailingNote(currentTime, lane, octaveAgnostic);
    if (recoverResult) {
      return { results: [recoverResult], wrong: false };
    }

    const targetPitchClass = octaveAgnostic ? pitchClassForLane(lane) : '';
    const hasPlayableNote = this._hasPlayableNote(
      currentTime,
      lane,
      octaveAgnostic,
      targetPitchClass,
    );
    if (!hasPlayableNote) {
      if (!this._isAutoPlayLane(lane, octaveAgnostic)) {
        this.scoring.recordWrongPress();
        return { results: [], wrong: true };
      }
      return { results: [], wrong: false };
    }
    if (this._learningAnchor === null) {
      // Unreachable: hasPlayableNote already confirmed a note exists within
      // TIMING.GOOD, so _tryNormalHit will always find it.
      const result = this._tryNormalHit(currentTime, lane, octaveAgnostic, pressOffsetMs);
      return { results: result ? [result] : [], wrong: false };
    }
    const inChord = octaveAgnostic
      ? this._learningChordLanesHasPitchClass(targetPitchClass)
      : this._learningChordLanes.has(lane);
    if (!inChord) {
      if (!this._isAutoPlayLane(lane, octaveAgnostic)) {
        this.scoring.recordWrongPress();
        return { results: [], wrong: true };
      }
      return { results: [], wrong: false };
    }

    if (
      this._learningChordPresses.size > 0 &&
      realTime - this._learningChordFirstPressRealTime > LEARNING_CHORD_WINDOW
    ) {
      this._learningChordPresses.clear();
    }

    if (this._learningChordPresses.size === 0) {
      this._learningChordFirstPressRealTime = realTime;
    }

    this._learningChordPresses.add(lane);

    if (this._learningChordPresses.size < this._learningChordLanes.size) {
      return { results: [], wrong: false };
    }

    const results: HitResult[] = [];
    for (const pressedLane of this._learningChordPresses) {
      const r = this.checkHit(currentTime, pressedLane, octaveAgnostic, pressOffsetMs);
      if (r) results.push(r);
    }
    this._learningChordPresses.clear();
    this._learningAnchor = null;
    this._learningChordLanes.clear();
    return { results, wrong: false };
  }

  getSongDuration(): number {
    if (this.notes.length === 0) return 0;
    const last = this.notes[this.notes.length - 1];
    return last.time + last.duration;
  }

  /** Find the start time of the next selected, unresolved note after `time`.
   *  Returns null when no more notes remain. */
  findNextUnplayedTime(time: number): number | null {
    for (const note of this.notes) {
      if (note.time <= time) continue;
      if (note.resolved || !this._isPlayerNote(note)) continue;
      return note.time;
    }
    return null;
  }

  /** Find the start time of the next player note after `time`, counting
   *  already-resolved notes: growing a loop extends its span even across
   *  notes the player has already covered. `cap` is an exclusive upper
   *  bound (the next loop's start). Returns null when none remain. */
  findNextPlayerNoteTime(time: number, cap: number | null = null): number | null {
    for (const note of this.notes) {
      if (note.time <= time) continue;
      if (cap !== null && note.time >= cap) return null;
      if (!this._isPlayerNote(note)) continue;
      return note.time;
    }
    return null;
  }

  /** New end boundary when removing the last note/chord from a loop
   *  covering `[startTime, endTime]`: the start of the previous playable
   *  note. Resolved notes still count, so trimming undoes an extension
   *  even after the added note was learned. Returns null when the loop
   *  covers fewer than two notes. */
  findLoopTrimEnd(startTime: number, endTime: number): number | null {
    let lastTime: number | null = null;

    for (let i = this.notes.length - 1; i >= 0; i--) {
      const note = this.notes[i];
      if (note.time > endTime) continue;
      if (note.time < startTime) break;
      if (!this._isPlayerNote(note)) continue;

      if (lastTime === null) {
        lastTime = note.time;
      } else if (note.time < lastTime) {
        return note.time > startTime ? note.time : null;
      }
    }

    return null;
  }

  /** The chord at a loop's new end boundary once its end moved from
   *  `oldEnd` to `newEnd`: on trim, the chord at the new end (the loop's
   *  new last note); on extend, the chord of the first player note after
   *  the old end — the newly added note — with `cap` as an exclusive
   *  upper bound, as in findNextPlayerNoteTime. Empty when the move
   *  added no player note: an extend that only closed the gap to the
   *  next loop. */
  findLoopBoundaryNotes(oldEnd: number, newEnd: number, cap: number | null): SongNote[] {
    if (newEnd < oldEnd) return this._notesAtTime(newEnd);

    const boundaryTime = this.findNextPlayerNoteTime(oldEnd, cap);

    return boundaryTime === null ? [] : this._notesAtTime(boundaryTime);
  }

  /** All notes starting exactly at `time` — the chord sounding at that instant. */
  private _notesAtTime(time: number): SongNote[] {
    return this.notes.filter((note) => note.time === time);
  }

  /** Returns the latest `time + duration` among notes whose start time is
   *  at or before `end`, so a loop wrapping at `end` lets the last note
   *  in the loop finish playing before rewinding. Returns `end` if no
   *  matching note is found. */
  getLoopEffectiveEnd(end: number): number {
    // Binary search the last note starting at or before `end`; the
    // prefix-max array then yields the furthest note end in one lookup.
    let lo = 0;
    let hi = this.notes.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.notes[mid].time <= end) {
        last = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return last >= 0 ? Math.max(end, this._noteEndMax[last]) : end;
  }

  /** Find the note closest to a click position in pixel space.
   *  Uses the renderer's coordinate mapping to compute 2D distance.
   *  Returns null if no note is within `maxRadius` pixels. */
  findNearestNoteByClick(
    clickX: number,
    clickY: number,
    renderer: Renderer,
    maxRadius = 30,
  ): SongNote | null {
    const ve = renderer.sheetViewEnd;
    const vs = renderer.sheetViewStart;
    if (ve <= vs) return null;

    const clickTime = vs + ((clickX - renderer.sheetBarX) / renderer.sheetBarW) * (ve - vs);
    const timeWindow = (maxRadius / renderer.sheetBarW) * (ve - vs) * CLICK_TIME_WINDOW_RATIO;

    let bestNote: SongNote | null = null;
    let bestDist = maxRadius * maxRadius;

    const checkNote = (note: SongNote): void => {
      const pos = renderer.notePixelPosition(note);
      if (!pos) return;
      const dx = pos.x - clickX;
      const dy = pos.y - clickY;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestNote = note;
      }
    };

    // Notes are sorted by time: binary-search the window start instead of
    // scanning every note on each mousemove.
    for (const list of [this.trebleNotes, this.bassNotes]) {
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid].time < clickTime - timeWindow) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < list.length; i++) {
        const note = list[i];
        if (note.time > clickTime + timeWindow) break;
        checkNote(note);
      }
    }

    return bestNote;
  }

  /** Find the active note for a lane closest to currentTime (for patch lookup). */
  findActiveNoteForLane(currentTime: number, lane: number): SongNote | null {
    let best: SongNote | null = null;
    let bestDiff = Infinity;
    for (const note of this.activeNotes) {
      if (note.lane !== lane) continue;
      if (note.autoPlayed) continue;
      const diff = Math.abs(note.time - currentTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = note;
      }
    }
    return best;
  }

  isComplete(): boolean {
    return this._selectedResolvedCount >= this._selectedNoteCount && this._selectedNoteCount > 0;
  }

  getActiveNotes(currentTime: number, height: number, learningMode = false): ActiveNoteRender[] {
    const hitZoneY = height * HIT_ZONE_Y_RATIO;
    let writeIdx = 0;

    for (const note of this.activeNotes) {
      if ((note.hit || note.missed) && !note.failing) continue;
      const color = handColor(note.key);

      if (writeIdx >= this._notePool.length) {
        this._notePool.push({
          lane: 0,
          y: 0,
          height: 0,
          color: '',
          alpha: 0,
          duration: 0,
          key: '',
          holding: false,
          waiting: false,
          selected: false,
        });
      }
      const r = this._notePool[writeIdx];

      if (note.holding) {
        const remaining = Math.max(12, (note.time + note.duration - currentTime) * SCROLL_SPEED);
        const y = hitZoneY - remaining;
        r.lane = note.lane;
        r.y = y;
        r.height = remaining;
        r.color = color;
        r.alpha = 1;
        r.duration = note.duration;
        r.key = note.key;
        r.holding = true;
        r.waiting = false;
        r.selected = note.selected;
      } else {
        const timeDiff = note.time - currentTime;
        const noteHeight = Math.max(12, note.duration * SCROLL_SPEED);
        const y = hitZoneY - timeDiff * SCROLL_SPEED - noteHeight;
        r.lane = note.lane;
        r.y = y;
        r.height = noteHeight;
        r.color = color;
        r.alpha = y + noteHeight < 0 ? 0 : 1;
        r.duration = note.duration;
        r.key = note.key;
        r.holding = false;
        r.waiting = learningMode && timeDiff <= 0;
        r.selected = note.selected;
      }
      writeIdx++;
    }

    this._notePool.length = writeIdx;
    return this._notePool;
  }
}
