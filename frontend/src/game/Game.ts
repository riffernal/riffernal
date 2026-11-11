// Game orchestrates the main loop, rendering, input, and scoring.
// Supports PLAY mode (full scoring) and LEARN mode (freezes at notes,
// optional one-hand practice with auto-played accompaniment).

import { Renderer } from './rendering/Renderer.js';
import { LoopDefinitionState } from './Loop.js';
export { LoopDefinitionState };
import { NoteManager, SCROLL_SPEED, HIT_ZONE_Y_RATIO } from './NoteManager.js';
import type { HitResult, ResolveResult, SongNote } from './NoteManager.js';
import { AutoVoiceScheduler, type AutoVoiceEntry } from './AutoVoiceScheduler.js';
import { DebugHud } from './debugHud.js';
import {
  NoteGrade,
  gradeLabel,
  TIMING_OFFSET_DISPLAY_THRESHOLD_MS,
  TAP_NOTE_THRESHOLD,
  SUCCESS_PARTICLE_HOLD_RATIO,
  comboBoost,
} from './scoring.js';
import type { Scoring } from './scoring.js';
import {
  NOTE_TO_LANE,
  handColor,
  getPianoKeyLayout,
  getVisibleRange,
  PracticeHand,
  GM_DRUM_CHANNEL,
} from '../utils/notes.js';
import { formatTime } from '../utils/helpers.js';
import { hasMeaningfulScore } from './scoring.js';
import type { VisibleRange } from '../utils/notes.js';
import type { Synth } from '../audio/Synth.js';
import type { Patch } from '../audio/patches/Patch.js';
import {
  guitarCleanPatch,
  guitarOverdrivenPatch,
  guitarDistortionPatch,
} from '../audio/patches/guitarPatch.js';
import { bassPatch } from '../audio/patches/bassPatch.js';
import { violinPatch } from '../audio/patches/violinPatch.js';
import { drumPatch } from '../audio/patches/drumPatch.js';
import type { KeyboardInput } from '../input/KeyboardInput.js';
import type { MidiInput } from '../input/MidiInput.js';
import { InputDeviceType } from '../input/types.js';
import type { ScoreDisplay } from '../ui/play/ScoreDisplay.js';
import { LoopScoreToast } from '../ui/play/LoopScoreToast.js';
import type { Song } from '../utils/MidiParser.js';
import { PlayMode } from '../api/SongApi.js';
import { LoopService, type SavedLoop, type LoopUpdates } from './LoopService.js';
import { ResultsScreen } from './rendering/ResultsScreen.js';
import type { NavAction } from '../ui/navFocus.js';
import { themeManager } from '../themes/ThemeManager.js';

export enum GameState {
  Menu = 'menu',
  Playing = 'playing',
  Results = 'results',
}

function getFeedbackColors(): Record<NoteGrade | 'MISS', string> {
  const c = themeManager.css;
  return {
    [NoteGrade.PERFECT]: c.accentYellow,
    [NoteGrade.GREAT]: c.accentGreen,
    [NoteGrade.GOOD]: c.accentBlue,
    MISS: c.accentRed,
  };
}

const COUNTDOWN_SECONDS = 1.5;
const RESULTS_DELAY_SECONDS = 1;
/** Pre-roll buffer applied at game start and between chained loops, so
 *  the player has a moment to prepare before notes activate. Matches the
 *  fresh-game countdown for visual consistency. */
const LOOP_TRANSITION_SECONDS = COUNTDOWN_SECONDS;

export class Game {
  // -- public properties --------------------------------------------------

  canvas: HTMLCanvasElement;
  renderer: Renderer;
  noteManager: NoteManager;
  state: GameState = GameState.Menu;
  currentTime = 0;
  scrollOffset = 0;
  speedMultiplier = 1.0;
  scoreDisplay: ScoreDisplay | null = null;
  learningMode = false;
  loopPlay = false;
  practiceHand: PracticeHand = PracticeHand.Both;
  songBpm = 120;
  showUsedKeys = true;
  octaveAgnostic = false;
  usedNoteRange: VisibleRange | null = null;
  /** When true, the web app's synth is silent on live key presses; the
   *  scored/visual note still plays so a plugged-in MIDI keyboard remains
   *  the audible source. Persisted per user-song. */
  mainTrackMuted = false;
  onResults: ((scoring: Scoring, song: Song) => void) | null = null;
  /** Fired once the results screen is up and gameplay input is released. */
  onResultsShown: (() => void) | null = null;
  /** Fired when the user navigates back to the menu from gameplay. */
  onBackToMenu: (() => void) | null = null;
  /** Fired (debounced externally) when the user changes the in-game Tracks
   *  panel state for the current song, so main.ts can persist it. */
  onTrackPreferencesChange: ((song: Song) => void) | null = null;
  /** Fired after the playback chain has advanced to another loop (wrap
   *  or gap jump), so the UI can refresh the loop status display. */
  onLoopAdvanced: (() => void) | null = null;
  onLoopScore: ((score: number) => void) | null = null;
  readonly loop = new LoopService();

  // -- public accessors ---------------------------------------------------

  get song(): Song | null {
    return this._currentSong;
  }
  get usedLearningMode(): boolean {
    return this._usedLearningMode;
  }
  get usedLoop(): boolean {
    return this._usedLoop;
  }
  get paused(): boolean {
    return this._paused;
  }

  // -- private properties -------------------------------------------------

  private _synth: Synth;
  private _keyboardInput: KeyboardInput;
  private _midiInput: MidiInput;
  private _currentSong: Song | null = null;
  private _refGameTime = 0;
  private _refRealTime = 0;
  private _preFrameRealTime = 0;
  private _learningFrozen = false;
  private _learningFrozenRealTime = 0;
  private _animationId: number | null = null;
  private _pressedLanes = new Map<number, number>();
  private _usedLearningMode = false;
  private _usedLoop = false;
  private _paused = false;
  private _resultsScreen = new ResultsScreen();
  private _playScreen: HTMLElement;
  private _freeplayScreen: HTMLElement;
  private _homeScreen: HTMLElement;
  private _resizeHandle: HTMLElement;
  private _timeDisplayEl: HTMLElement;
  private _songTitleEl: HTMLElement;
  private readonly _baseDocTitle = document.title;
  private _onResize: () => void;
  private _resizeRaf = false;
  private _lastFrameTime = 0;
  private _completionTime: number | null = null;
  private _lastSheetBottom = -1;
  private _frameCount = 0;
  private _autoScheduler: AutoVoiceScheduler;
  private _debugHud = new DebugHud();
  private _loopScoreToast = new LoopScoreToast();

  constructor(
    canvas: HTMLCanvasElement,
    synth: Synth,
    keyboardInput: KeyboardInput,
    midiInput: MidiInput,
  ) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    this.noteManager = new NoteManager();
    this._synth = synth;
    this._keyboardInput = keyboardInput;
    this._midiInput = midiInput;
    this._autoScheduler = new AutoVoiceScheduler((entry) => this._buildAutoVoice(entry));

    document.addEventListener('keydown', (e) => {
      if (e.code === 'F8') {
        e.preventDefault();
        this._debugHud.toggle();
      }
    });
    if (new URLSearchParams(location.search).get('debug') === '1') {
      this._debugHud.show();
    }

    this._playScreen = document.getElementById('play-screen')!;
    this._freeplayScreen = document.getElementById('freeplay-screen')!;
    this._homeScreen = document.getElementById('home-screen')!;
    this._resizeHandle = document.getElementById('sheet-resize-handle')!;
    this._timeDisplayEl = document.getElementById('time-display')!;
    this._songTitleEl = document.getElementById('song-title-display')!;

    this._onResize = () => {
      if (!this._resizeRaf) {
        this._resizeRaf = true;
        requestAnimationFrame(() => {
          this.renderer.resize();
          this._resizeRaf = false;
        });
      }
    };
    window.addEventListener('resize', this._onResize);
  }

  /** Main animation-frame tick: advances game time, renders the frame, and
   *  re-arms itself until the game returns to the menu. Arrow property so it
   *  can be passed directly to requestAnimationFrame. */
  private _mainLoop = (): void => {
    if (this._paused) return;

    const frameStartMs = performance.now();
    const now = performance.now() / 1000;
    const delta = this._lastFrameTime ? now - this._lastFrameTime : 1 / 60;
    this._lastFrameTime = now;
    this._frameCount++;

    this._preFrameRealTime = this._refRealTime;
    const prevTime = this.currentTime;
    this._updateFrameTime(now, delta);
    // Track freeze transitions so the real-time anchor is captured exactly
    // once per freeze (at its start) and survives wrong/partial presses.
    const frozenNow =
      this.learningMode &&
      !this.loopPlay &&
      this.state === GameState.Playing &&
      this.currentTime === prevTime;

    if (frozenNow && !this._learningFrozen) {
      this._learningFrozenRealTime = this._preFrameRealTime;
    }

    this._learningFrozen = frozenNow;
    this._checkLoopWrap();

    this.scrollOffset += SCROLL_SPEED * delta * this.speedMultiplier;

    this.renderer.clear();
    this.renderer.beginFrame(performance.now());
    this.renderer.drawHighway(this.scrollOffset, this._pressedLanes, this.usedNoteRange);

    if (this.state === GameState.Playing) {
      this._renderPlayingFrame(delta);
    }

    if (this.renderer.sheetBottom !== this._lastSheetBottom) {
      this._lastSheetBottom = this.renderer.sheetBottom;
      this._resizeHandle.style.top = `${this.renderer.sheetBottom}px`;
    }

    this.renderer.drawParticles();
    this.renderer.piano.showComputerKeys =
      this._midiInput.device.type === InputDeviceType.ComputerKeyboard;
    this.renderer.drawPiano(this._pressedLanes, this.usedNoteRange);
    this.renderer.drawHitZone(this._pressedLanes, this.usedNoteRange);

    if (this.state !== GameState.Menu) {
      if (this._debugHud.visible) {
        this._debugHud.update({
          frameDeltaSec: delta,
          workMs: performance.now() - frameStartMs,
          audioNow: this._synth.now(),
          wallNow: performance.now() / 1000,
          currentTime: this.currentTime,
          speedMultiplier: this.speedMultiplier,
          voices: this._synth.activeVoices,
          backgroundVoices: this._synth.backgroundVoices,
          pendingBuilds: this._autoScheduler.pending,
          totalBuilds: this._synth.totalBuilds,
        });
      }
      this._animationId = requestAnimationFrame(this._mainLoop);
    }
  };

  // -- Loop forwarding ------------------------------------------------------

  /** Current (playing) loop's start, or null when the chain is idle. */
  get loopStart(): number | null {
    return this.loop.start;
  }
  /** Current loop's end, or null when the chain is idle. */
  get loopEnd(): number | null {
    return this.loop.end;
  }
  /** True when the chain is engaged (≥1 enabled loop, currentIndex set). */
  get loopActive(): boolean {
    return this.loop.active;
  }
  get loopDefinitionState(): LoopDefinitionState {
    return this.loop.definitionState;
  }
  set loopDefinitionState(v: LoopDefinitionState) {
    this.loop.definitionState = v;
  }

  beginLoopDefine(): void {
    this.loop.beginDefine();
  }
  setLoopBoundary(time: number): LoopDefinitionState {
    return this.loop.setBoundary(time);
  }
  /** Abort the in-progress define draft. */
  cancelLoopDraft(): void {
    this.loop.cancelDraft();
  }
  /** Disengage the chain (e.g. when switching to PLAY mode). Saved loops
   *  are kept; only the active playback position is cleared. */
  deactivateLoop(): void {
    this.loop.disengage();
    this.loopPlay = false;
  }
  /** Fully reset loop state — used by `start()` on a fresh game. */
  clearLoop(): void {
    this.loop.clear();
    this.loopPlay = false;
  }

  /** Engage the chain from the first enabled loop and seek to it with the
   *  countdown buffer. Returns true when engaged (≥1 enabled loop). Called
   *  by main.ts after `start()` for a fresh game; `retry()` does NOT call
   *  this so it can preserve the user's engaged/disengaged state. */
  engageChain(): boolean {
    if (!this.loop.engage()) return false;
    this._usedLoop = true;
    const first = this.loop.current;
    if (first && this.state === GameState.Playing) {
      this._seekWithBuffer(first.startTime, COUNTDOWN_SECONDS);
    }
    return true;
  }

  /** Load saved loops for the current song into the controller (no
   *  chain engagement or seek). Call before `start()` so `start()` can
   *  engage the chain with the countdown buffer. Also disengages any
   *  stale chain state from a previous song. */
  loadLoops(
    loops: Array<{
      id: number;
      startTime: number;
      endTime: number;
      enabled: boolean;
      name: string | null;
    }>,
  ): void {
    this.loop.setLoops(loops);
    this.loop.disengage();
    this.loop.cancelDraft();
  }

  /** Add a saved loop (already persisted) to the controller's local set.
   *  If the chain is engaged the new loop participates in the next chain
   *  recompute. If the chain is idle and the new loop is enabled, engage. */
  addSavedLoop(loop: {
    id: number;
    startTime: number;
    endTime: number;
    enabled: boolean;
    name: string | null;
  }): void {
    this.loop.addLoop(loop);
    if (!this.loop.active && this.loop.chain.length > 0) {
      this.loop.engage();
      this._usedLoop = true;
      const first = this.loop.current;
      if (first && this.state === GameState.Playing) {
        this._seekWithBuffer(first.startTime, LOOP_TRANSITION_SECONDS);
      }
    }
  }

  setLoopProperties(loopId: number, updates: LoopUpdates): void {
    const wasCurrent = this.loop.current?.id === loopId;
    this.loop.updateLoop(loopId, updates);

    if (!('enabled' in updates)) return;

    const chainLen = this.loop.chain.length;
    if (chainLen === 0) {
      if (this.loop.active) {
        this.loop.disengage();
        this.loopPlay = false;
      }
      return;
    }

    const outOfBounds = this.loop.currentIndex !== null && this.loop.currentIndex >= chainLen;
    const needReengage =
      this.loop.currentIndex === null || (updates.enabled === false && wasCurrent) || outOfBounds;
    if (needReengage && this.state === GameState.Playing) {
      this.loop.engage();
      this._usedLoop = true;
      const first = this.loop.current;
      if (first) this._seekWithBuffer(first.startTime, LOOP_TRANSITION_SECONDS);
    }
  }

  /** Delete a saved loop. Adjusts the chain: if the current loop was
   *  removed, advance to the next (or disengage if the chain is empty). */
  deleteSavedLoop(loopId: number): void {
    const wasCurrent = this.loop.current?.id === loopId;
    this.loop.remove(loopId);
    const chainLen = this.loop.chain.length;
    if (chainLen === 0) {
      this.loop.disengage();
      this.loopPlay = false;
      return;
    }
    if (wasCurrent && this.state === GameState.Playing) {
      // The current loop was removed. Clamp currentIndex to the new
      // chain length (lands on the loop that shifted into its slot, or
      // the last loop if the deleted one was at the end) and seek there.
      this.loop.currentIndex = Math.min(this.loop.currentIndex ?? 0, chainLen - 1);
      const current = this.loop.current;
      if (current) this._seekWithBuffer(current.startTime, LOOP_TRANSITION_SECONDS);
    }
  }

  /** New end when extending a loop by one note: the next player note
   *  after `endTime` (resolved notes count), or — when that note already
   *  belongs to the following loop — the following loop's start, so the
   *  loops sit adjacent without overlapping. null when the loop cannot
   *  grow (no notes remain, or it already touches the next loop). */
  findLoopExtendEnd(startTime: number, endTime: number): number | null {
    const cap = this.loop.nextStartAfter(startTime);
    const nextNote = this.noteManager.findNextPlayerNoteTime(endTime, cap);
    if (nextNote !== null) return nextNote;
    return cap !== null && cap > endTime ? cap : null;
  }

  /** Audible trim/extend feedback: play the chord at the loop's new end
   *  boundary (its new last note). Silent when the move added no player
   *  note — an extend that only closed the gap to the next loop. */
  playLoopBoundaryNotes(loopStart: number, oldEnd: number, newEnd: number): void {
    const cap = this.loop.nextStartAfter(loopStart);
    const notes = this.noteManager.findLoopBoundaryNotes(oldEnd, newEnd, cap);

    for (const note of notes) {
      this._playNoteOnce(note);
    }
  }

  // -- Frame time & loop wrap -----------------------------------------------

  private _updateFrameTime(now: number, _delta: number): void {
    const rawTime = this._refGameTime + (now - this._refRealTime) * this.speedMultiplier;

    let frameTime = rawTime;
    if (this.learningMode && !this.loopPlay && this.state === GameState.Playing) {
      const loopEndCutoff = this.loop.active ? this.loop.end : null;
      const waitTime = this.noteManager.getEarliestWaitTime(rawTime, loopEndCutoff);
      if (waitTime !== null) frameTime = Math.min(rawTime, waitTime);
      if (frameTime < rawTime) {
        // Frozen at a waiting note: re-anchor so rawTime doesn't race ahead
        // while the player takes their time. Otherwise, on release the game
        // time would snap forward by the full wait duration, causing the
        // next notes to fail instantly and failing notes to scroll too fast.
        this._refGameTime = frameTime;
        this._refRealTime = now;
      }
    }
    this.currentTime = frameTime;
  }

  private _checkLoopWrap(): void {
    const chain = this.loop.chain;
    const idx = this.loop.currentIndex;
    if (chain.length === 0 || idx === null || idx >= chain.length) return;
    const current = chain[idx];
    const effectiveEnd = this.noteManager.getLoopEffectiveEnd(current.endTime);
    if (!(this.currentTime >= effectiveEnd)) return;

    this._advanceToNextLoop(current);
  }

  /** Advance the engaged chain to its next loop (wraps to 0 at the end),
   *  then seek there: with a pre-roll buffer when the chain jumps to a
   *  new region (a forward gap after the current loop, or a wrap-around
   *  to an earlier one), seamlessly otherwise (adjacent loops, or a
   *  single loop wrapping back to itself). */
  private _advanceToNextLoop(current: SavedLoop): void {
    this._bankLoopScore();
    const prevIndex = this.loop.currentIndex;
    this.noteManager.scoring.resetCombo();
    const next = this.loop.advance();
    if (!next) return;

    const sameLoop = prevIndex !== null && this.loop.currentIndex === prevIndex;
    const wrappedAround = !sameLoop && this.loop.currentIndex! < prevIndex!;
    const hasGap = wrappedAround || (!sameLoop && next.startTime > current.endTime);
    if (hasGap) {
      this._seekWithBuffer(next.startTime, LOOP_TRANSITION_SECONDS);
    } else {
      this.seekTo(next.startTime);
    }
    this.onLoopAdvanced?.();
  }

  /** Bank the score accumulated during the loop pass that just finished:
   *  reset the live score for the next pass, flash the amount, and hand it
   *  to the app for the daily total. */
  private _bankLoopScore(): void {
    const score = this.noteManager.scoring.score;
    this.noteManager.scoring.resetScore();
    if (score <= 0) return;

    this._loopScoreToast.show(score);
    this.onLoopScore?.(score);
  }

  /** Upgrade the loop-score toast's caption with the confirmed daily total. */
  updateLoopScoreDailyTotal(score: number, dailyTotal: number): void {
    this._loopScoreToast.updateDailyTotal(score, dailyTotal);
  }

  /** Seek to `time` with a pre-roll `buffer` (seconds) so the player has a
   *  visual lead-in before notes activate. Delegates to `seekTo` for the
   *  shared clamp/reset logic, then backs up the time anchors by `buffer`. */
  private _seekWithBuffer(time: number, buffer: number): void {
    this.seekTo(time);
    this._refGameTime = this.currentTime - buffer;
    this.currentTime = this._refGameTime;
  }

  // -- Playing frame rendering ----------------------------------------------

  private _renderPlayingFrame(deltaSec: number): void {
    const loopEndCutoff = this.loop.active ? this.loop.end : null;
    this.noteManager.update(this.currentTime, this.renderer.height, loopEndCutoff);
    this._autoScheduler.drain(this._synth.now(), deltaSec);

    this.renderer.drawSheetMusic(
      this.noteManager.trebleNotes,
      this.noteManager.bassNotes,
      this.currentTime,
      this.noteManager.getSongDuration(),
      this.loop.snapshot(),
      undefined,
      this.songBpm,
    );

    const activeNotes = this.noteManager.getActiveNotes(
      this.currentTime,
      this.renderer.height,
      this.learningMode,
    );
    const combo = this.noteManager.scoring.combo;
    for (const note of activeNotes) {
      this.renderer.drawNote(
        note.lane,
        note.y,
        note.height,
        note.selected ? note.color : themeManager.canvas.backingNote,
        note.alpha,
        combo,
        note.key,
        note.holding,
        note.waiting,
        this.usedNoteRange,
      );
    }

    this.renderer.drawGrind(this.currentTime, this.usedNoteRange);

    this.scoreDisplay?.update(this.noteManager.scoring);
    if (this._frameCount % 6 === 0) {
      this._timeDisplayEl.textContent = `${formatTime(this.currentTime)} / ${formatTime(this.noteManager.getSongDuration())}`;
    }
    this._checkCompletion();
  }

  private _checkCompletion(): void {
    if (!this.noteManager.isComplete()) {
      this._completionTime = null;
      return;
    }
    if (this._completionTime === null) {
      this._completionTime = this.currentTime;
    } else if (this.currentTime - this._completionTime >= RESULTS_DELAY_SECONDS) {
      this._showResults();
    }
  }

  // -- Song lifecycle -------------------------------------------------------

  start(song: Song): void {
    if (this._animationId !== null) {
      cancelAnimationFrame(this._animationId);
      this._animationId = null;
    }

    this._currentSong = song;
    this._updateSongTitleDisplay();
    this.noteManager.loadSong(song);
    this.songBpm = song.bpm;
    this._refGameTime = -COUNTDOWN_SECONDS;
    this._refRealTime = performance.now() / 1000;
    this._learningFrozen = false;
    this.state = GameState.Playing;
    this._pressedLanes.clear();
    this._completionTime = null;
    this._paused = false;
    this._usedLearningMode = this.learningMode;
    this._usedLoop = false;
    this.renderer.clearGrind();
    this._computeUsedNoteRange(song);

    this._freeplayScreen.classList.remove('active');
    this._homeScreen.classList.remove('active');
    this._resultsScreen.hide();
    this._playScreen.classList.add('active');

    // Reset chain/draft state but keep saved loops (loaded by main.ts
    // via loadLoops before start()). clearLoop() would wipe them.
    this.loop.disengage();
    this.loop.cancelDraft();
    this.loopPlay = false;
    this._setupInputHandlers();
    this._setupNoteCallbacks();

    this._lastFrameTime = 0;
    this._mainLoop();
  }

  /** False while the browser blocks audio until a click or key press. */
  tryResumeAudio(): Promise<boolean> {
    return this._synth.tryResume();
  }

  /** Pause the game loop. Used by main.ts to freeze the game while the
   *  pre-game info popup is visible. */
  pause(): void {
    this._paused = true;
  }

  private _computeUsedNoteRange(song: Song): void {
    this.usedNoteRange = this.showUsedKeys ? getVisibleRange(song.notes.map((n) => n.key)) : null;
  }

  /** Show the current song's title and artist in the play-screen HUD and
   *  the browser tab title while a song is active. */
  private _updateSongTitleDisplay(): void {
    const song = this._currentSong;

    if (!song) return;

    const label = song.artist ? `${song.title} — ${song.artist}` : song.title;
    this._songTitleEl.textContent = label;
    document.title = `${label} | ${this._baseDocTitle}`;
  }

  setShowUsedKeys(enabled: boolean): void {
    this.showUsedKeys = enabled;
    if (this._currentSong) {
      this._computeUsedNoteRange(this._currentSong);
    }
  }

  private _setupInputHandlers(): void {
    this._keyboardInput.onNoteOn = (note, keyCode, velocity) =>
      this._handleNoteOn(note, keyCode, velocity);
    this._keyboardInput.onNoteOff = (note, keyCode) => this._handleNoteOff(note, keyCode);
    this._midiInput.onNoteOn = (note, id, velocity) => this._handleNoteOn(note, id, velocity);
    this._midiInput.onNoteOff = (note, id) => this._handleNoteOff(note, id);

    this._keyboardInput.start();
    this._synth.init();
    this._synth.resume();
  }

  private _setupNoteCallbacks(): void {
    this.noteManager.onMiss = (note) => this._playNoteOnce(note);
    // Background/accompaniment audio is scheduled ahead of its audible time
    // (see _scheduleAutoNote); onAutoPlayOn no longer triggers audio here.
    this.noteManager.onAutoPlayOn = null;
    this.noteManager.onAutoPlaySchedule = (note) => this._scheduleAutoNote(note);

    this.noteManager.onResolve = (result) => {
      const grade = result.grade;
      if (grade === null) {
        this.scoreDisplay?.showFeedback('Miss', getFeedbackColors().MISS);
        return;
      }
      const label = gradeLabel(grade);
      const color = getFeedbackColors()[grade];
      this.scoreDisplay?.showFeedback(this._hitFeedbackText(result, label), color);

      const note = result.note;
      const holdRatio = note.duration > 0 ? note.accumulatedHeldDuration / note.duration : 0;
      const isTapNote = note.duration <= TAP_NOTE_THRESHOLD;

      if (holdRatio >= SUCCESS_PARTICLE_HOLD_RATIO || isTapNote) {
        const hitZoneY = this.renderer.height * HIT_ZONE_Y_RATIO;
        const keyLayout = getPianoKeyLayout(note.key, this.renderer.width, this.usedNoteRange);
        const noteColor = handColor(note.key);
        const combo = this.noteManager.scoring.combo;
        const count = 10 + Math.floor(comboBoost(combo) * 20);
        this.renderer.spawnParticles(keyLayout.x + keyLayout.width / 2, hitZoneY, noteColor, count);
      }
    };
  }

  /** Per-note offset feedback is a learn-mode teaching aid; play mode
   *  still records offsets for the results-screen timing stat. */
  private _hitFeedbackText(result: ResolveResult, label: string): string {
    let text = `+${result.score} ${label}`;

    if (this.learningMode) {
      const ms = Math.abs(result.offsetMs);
      if (ms > TIMING_OFFSET_DISPLAY_THRESHOLD_MS) {
        const dir = result.offsetMs > 0 ? 'late' : 'early';
        text += `\n<span class="timing-offset">${ms} ms ${dir}</span>`;
      }
    }

    return text;
  }

  // -- Input handling -------------------------------------------------------

  private _handleNoteOn(noteName: string, _id: string, velocity: number): void {
    const lane = NOTE_TO_LANE.get(noteName);
    if (lane === undefined) return;

    this._pressedLanes.set(lane, velocity);
    const activeNote = this.noteManager.findActiveNoteForLane(this.currentTime, lane);
    if (!this.mainTrackMuted) {
      const patch = activeNote
        ? this._patchForNote(activeNote.program, activeNote.channel)
        : this._synth.getPatch();
      this._synth.noteOn(noteName, patch, undefined, activeNote?.rawMidi);
    }

    if (this.state === GameState.Playing) {
      const results = this._resolveHit(lane);
      this._spawnPerfectParticles(results);
      this._triggerGrind(results);
    }
  }

  private _resolveHit(lane: number): HitResult[] {
    if (this.learningMode) {
      // While frozen, game time is pinned at the note, so the offset must come
      // from real time vs the freeze anchor. Unfrozen (early) presses fall
      // back to the game-time diff inside NoteManager, which stays signed.
      let pressOffsetMs: number | null = null;

      if (this._learningFrozen) {
        pressOffsetMs = Math.round(
          (performance.now() - this._learningFrozenRealTime * 1000) * this.speedMultiplier,
        );
      }

      const outcome = this.noteManager.checkLearningHit(
        this.currentTime,
        lane,
        performance.now(),
        this.octaveAgnostic,
        pressOffsetMs,
      );
      if (outcome.wrong) {
        this.renderer.flashWrongKey(lane);
        this.scoreDisplay?.showFeedback('Wrong', getFeedbackColors().MISS);
      }
      return outcome.results;
    }
    const r = this.noteManager.checkHit(this.currentTime, lane, this.octaveAgnostic);
    if (
      r === null &&
      !this.noteManager.hasUnresolvedNoteInLane(lane, this.currentTime, this.octaveAgnostic)
    ) {
      this.scoreDisplay?.showFeedback('Wrong', getFeedbackColors().MISS);
    }
    return r ? [r] : [];
  }

  private _spawnPerfectParticles(results: HitResult[]): void {
    const hitZoneY = this.renderer.height * HIT_ZONE_Y_RATIO;
    const combo = this.noteManager.scoring.combo;
    const comboBoostValue = comboBoost(combo);
    for (const result of results) {
      if (result.result === NoteGrade.PERFECT) {
        const noteColor = handColor(result.note.key);
        const keyLayout = getPianoKeyLayout(
          result.note.key,
          this.renderer.width,
          this.usedNoteRange,
        );
        this.renderer.spawnParticles(
          keyLayout.x + keyLayout.width / 2,
          hitZoneY,
          noteColor,
          15 + Math.floor(comboBoostValue * 25),
        );
      }
    }
  }

  private _triggerGrind(results: HitResult[]): void {
    if (results.length === 0) return;
    for (const result of results) {
      const grindLane = result.note.lane;
      const color = handColor(result.note.key);
      this.renderer.triggerGrindFlash(grindLane, color);
      if (result.note.holding && result.note.duration > TAP_NOTE_THRESHOLD) {
        this.renderer.startGrindBeam(grindLane, color, result.note.time + result.note.duration);
      }
    }
  }

  private _handleNoteOff(noteName: string, _id: string): void {
    const lane = NOTE_TO_LANE.get(noteName);
    if (lane === undefined) return;

    this._pressedLanes.delete(lane);
    this._synth.noteOff(noteName);
    this.renderer.endGrindBeam(lane);

    if (this.state === GameState.Playing) {
      const release = this.noteManager.checkRelease(this.currentTime, lane, this.octaveAgnostic);

      // Learn-mode teaching aid: a hold released too early flashes the key
      // red; the note itself stays normal-looking and can be re-pressed.
      if (this.learningMode && release?.note.failing) {
        this.renderer.flashWrongKey(lane);
      }
    }
  }

  // -- Results & navigation -------------------------------------------------

  isNewBest(): boolean {
    const score = this.noteManager.scoring.score;

    return (
      !this._usedLearningMode &&
      this._currentSong != null &&
      hasMeaningfulScore(score) &&
      (this._currentSong.bestScore == null || score > this._currentSong.bestScore)
    );
  }

  private _showResults(): void {
    this.state = GameState.Results;
    this._playScreen.classList.remove('active');

    this._resultsScreen.show(this.noteManager.scoring, this._usedLearningMode, this.isNewBest());

    if (this._currentSong) {
      this.onResults?.(this.noteManager.scoring, this._currentSong);
    }

    this._keyboardInput.stop();
    this._midiInput.onNoteOn = null;
    this._midiInput.onNoteOff = null;
    this._synth.releaseAll();
    this._autoScheduler.clear();
    this.onResultsShown?.();
  }

  runResultsAction(action: NavAction): void {
    this._resultsScreen.runAction(action);
  }

  retry(): void {
    if (!this._currentSong) return;
    // Preserve saved loops across a restart. start() disengages the chain
    // (but keeps saved loops). When in LEARN mode and ≥1 loop is enabled,
    // restart always goes back to the FIRST enabled loop (index 0) with
    // the pre-roll buffer — regardless of where playback was before. In
    // PLAY mode (or with zero enabled loops), the song restarts from the
    // beginning normally, since a competitive PLAY run should not be
    // looped. Callers (main.ts) call setMode() before retry(), so
    // learningMode reflects the intended post-retry mode by the time we
    // reach here.
    const savedLoops = this.loop.loops;
    this.start(this._currentSong);
    this.loop.setLoops(savedLoops);
    if (this.learningMode && this.loop.chain.length > 0) {
      this.loop.engage();
      this._usedLoop = true;
      const first = this.loop.current;
      if (first) this._seekWithBuffer(first.startTime, LOOP_TRANSITION_SECONDS);
    }
  }

  backToMenu(): void {
    this.state = GameState.Menu;
    this._resultsScreen.hide();
    this._playScreen.classList.remove('active');
    this._songTitleEl.textContent = '';
    document.title = this._baseDocTitle;
    this._keyboardInput.stop();
    this._synth.releaseAll();
    this._autoScheduler.clear();
    this._keyboardInput.onNoteOn = null;
    this._keyboardInput.onNoteOff = null;
    this._midiInput.onNoteOn = null;
    this._midiInput.onNoteOff = null;
    if (this._animationId !== null) {
      cancelAnimationFrame(this._animationId);
      this._animationId = null;
    }
    this.onBackToMenu?.();
  }

  private _patchForNote(program: number, channel: number): Patch {
    if (channel === GM_DRUM_CHANNEL) return drumPatch;
    // GM Guitar programs: 25-31 (Steel, Jazz, Clean, Muted, Overdriven, Distortion, Harmonics)
    if (program >= 25 && program <= 28) return guitarCleanPatch;
    if (program === 29) return guitarOverdrivenPatch;
    if (program === 30) return guitarDistortionPatch;
    if (program === 31) return guitarCleanPatch;
    // GM Bass programs: 32-39 (Acoustic Bass through Synth Bass 2)
    if (program >= 32 && program <= 39) return bassPatch;
    // GM bowed strings: 40-44 (Violin, Viola, Cello, Contrabass, Tremolo Strings)
    // GM string ensembles: 48-51 (String Ensemble, Synth Strings)
    if ((program >= 40 && program <= 44) || (program >= 48 && program <= 51)) return violinPatch;
    return this._synth.getPatch();
  }

  private _playNoteOnce(note: SongNote): void {
    // Honour the main-track mute for foreground (selected) notes — these are
    // the "note songs" the player is meant to play, auto-played on miss in
    // PLAY mode. Background-accompaniment notes are governed by their own
    // per-track toggle and must keep playing.
    if (note.selected && this.mainTrackMuted) return;
    const realDuration = (note.duration * 1000) / this.speedMultiplier;
    const id = `auto_${note.track}_${note.time}_${note.key}`;
    const patch = this._patchForNote(note.program, note.channel);
    this._synth.noteOn(note.key, patch, id, note.rawMidi);
    setTimeout(() => this._synth.noteOff(id), realDuration);
  }

  /** Queues a background voice to be built slightly ahead of its audible
   *  time. The scheduler spreads builds across frames (see
   *  AutoVoiceScheduler) so dense band entries never burst every synth
   *  graph into the single frame that first crosses the schedule window. */
  private _scheduleAutoNote(note: SongNote): void {
    if (note.selected && this.mainTrackMuted) return;
    const aheadRealSec = (note.time - this.currentTime) / this.speedMultiplier;
    this._autoScheduler.enqueue({
      id: `auto_${note.track}_${note.time}_${note.key}`,
      noteName: note.key,
      midiOverride: note.rawMidi,
      patch: this._patchForNote(note.program, note.channel),
      when: this._synth.now() + aheadRealSec,
      durationMs: (note.duration * 1000) / this.speedMultiplier,
    });
  }

  private _buildAutoVoice(entry: AutoVoiceEntry): void {
    const audioNow = this._synth.now();
    this._synth.noteOn(entry.noteName, entry.patch, entry.id, entry.midiOverride, entry.when);
    const remainingMs = Math.max(0, (entry.when - audioNow) * 1000 + entry.durationMs);
    setTimeout(() => this._synth.noteOff(entry.id), remainingMs);
  }

  // -- Playback controls ----------------------------------------------------

  togglePause(): void {
    if (this._paused) {
      this._paused = false;
      this._refGameTime = this.currentTime;
      this._refRealTime = performance.now() / 1000;
      // Force a freeze transition on the next frame so the real-time anchor
      // is recaptured at resume time, not the pre-pause instant.
      this._learningFrozen = false;
      this._lastFrameTime = 0;
      this._mainLoop();
    } else {
      this._paused = true;
      if (this._animationId !== null) {
        cancelAnimationFrame(this._animationId);
        this._animationId = null;
      }
    }
  }

  setSpeed(multiplier: number): void {
    this._refGameTime = this.currentTime;
    this._refRealTime = performance.now() / 1000;
    this.speedMultiplier = Math.max(0.1, Math.min(2.0, multiplier));
  }

  /** Re-anchor playback at `time` (seconds) and reset note gameplay state
   *  from that point onward. Used by loop wrap and click-to-seek. */
  seekTo(time: number): void {
    const duration = this.noteManager.getSongDuration();
    const clamped = Math.max(0, Math.min(time, Math.max(0, duration - 0.01)));
    this._refGameTime = clamped;
    this._refRealTime = performance.now() / 1000;
    this.currentTime = clamped;
    this._learningFrozen = false;
    this.scrollOffset = 0;
    this._completionTime = null;
    this._pressedLanes.clear();
    this.renderer.clearGrind();
    // Kill sounding and lookahead-scheduled voices: nothing from the old
    // position may ring into the new one.
    this._synth.releaseAll();
    this._autoScheduler.clear();
    this.noteManager.resetFromTime(clamped);
  }

  seekToNextNote(): void {
    const nextTime = this.noteManager.findNextUnplayedTime(this.currentTime);
    if (nextTime !== null) {
      this.seekTo(Math.max(0, nextTime - 2));
    }
  }

  setLearningMode(enabled: boolean, persist = true): void {
    this.learningMode = enabled;
    this.noteManager.learningMode = enabled;
    if (enabled) this._usedLearningMode = true;
    this.noteManager.resetLearningState();
    this._refGameTime = this.currentTime;
    this._refRealTime = performance.now() / 1000;
    this._learningFrozen = false;

    if (persist && this._currentSong) {
      this._syncTrackPreferences();
      this.onTrackPreferencesChange?.(this._currentSong);
    }
  }

  setPracticeHand(hand: PracticeHand): void {
    this.practiceHand = hand;
    this.noteManager.practiceHand = hand;
    this.noteManager.resetLearningState();
  }

  setBackgroundTrack(trackIndex: number, enabled: boolean): void {
    this.noteManager.setBackgroundTrack(trackIndex, enabled);
    if (this._currentSong) {
      if (enabled) {
        if (!this._currentSong.backgroundTracks) this._currentSong.backgroundTracks = [];
        if (!this._currentSong.backgroundTracks.includes(trackIndex)) {
          this._currentSong.backgroundTracks.push(trackIndex);
        }
      } else {
        if (this._currentSong.backgroundTracks) {
          this._currentSong.backgroundTracks = this._currentSong.backgroundTracks.filter(
            (i) => i !== trackIndex,
          );
        }
      }
      this._syncTrackPreferences();
      this.onTrackPreferencesChange?.(this._currentSong);
    }
  }

  /** Mute or unmute the main (live key-press) track. The scored/visual note
   *  still plays; only the app's synth output for live presses is silenced
   *  so a plugged-in MIDI keyboard remains audible. */
  setMainTrackMuted(muted: boolean): void {
    this.mainTrackMuted = muted;
    if (this._currentSong) {
      this._syncTrackPreferences();
      this.onTrackPreferencesChange?.(this._currentSong);
    }
  }

  private _syncTrackPreferences(): void {
    if (!this._currentSong) return;
    this._currentSong.trackPreferences = {
      backgroundTracks: [...(this._currentSong.backgroundTracks ?? [])],
      mainTrackMuted: this.mainTrackMuted,
      playMode: this.learningMode ? PlayMode.Learn : PlayMode.Play,
    };
  }
}
