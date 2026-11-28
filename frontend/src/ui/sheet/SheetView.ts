import { type Game, GameState, LoopDefinitionState } from '../../game/Game.js';
import { SHEET_TOP_OFFSET, Renderer, SHEET_BEATS_VISIBLE } from '../../game/rendering/Renderer.js';
import type { SongNote } from '../../game/NoteManager.js';
import { createLoop } from '../../api/LoopApi.js';
import { setupHoverCursor } from '../play/HoverCursor.js';
import { LoopsPanel } from './LoopsPanel.js';
import {
  BTN_ADD_LOOP_ID,
  BTN_CLOSE_SHEET_ID,
  BTN_DEFINE_LOOP_ID,
  BTN_OPEN_SHEET_ID,
  BTN_SHEET_NEXT_ID,
  BTN_SHEET_PREV_ID,
  SHEET_CANVAS_ID,
  SHEET_HINT_ID,
  SHEET_PAGE_INFO_ID,
  SHEET_RESIZE_HANDLE_ID,
  SHEET_SCREEN_ID,
} from './sheetElementIds.js';
import { reportError } from '../../utils/helpers.js';

const SHEET_STAFF_LINE_SPACING = 10;
export const BASE_SHEET_HEIGHT =
  5 + 4 * SHEET_STAFF_LINE_SPACING + 24 + 4 * SHEET_STAFF_LINE_SPACING + 5;

export interface SheetViewDeps {
  setMode: (learning: boolean) => void;
  updateLoopUI: () => void;
}

export class SheetView {
  private _game: Game;
  private _canvas: HTMLCanvasElement;
  private _deps: SheetViewDeps;
  private _loopsPanel: LoopsPanel;

  private _sheetScreen: HTMLElement;
  private _sheetCanvas: HTMLCanvasElement;
  private _sheetRenderer: Renderer;
  private _sheetOpen = false;
  private _sheetCurrentPage = 0;
  private _sheetRAF: number | null = null;
  private _lastPanelRenderLoopId: number | null = null;

  private _sheetPageInfo: HTMLElement;
  private _sheetHint: HTMLElement;
  private _sheetPrevBtn: HTMLElement;
  private _sheetNextBtn: HTMLElement;

  constructor(game: Game, canvas: HTMLCanvasElement, deps: SheetViewDeps) {
    this._game = game;
    this._canvas = canvas;
    this._deps = deps;

    const onLoopsMutated = (opts?: { scrollToEnd?: boolean }) => {
      this._deps.updateLoopUI();

      if (this._sheetOpen) {
        const selectedLoop = this._getSelectedLoopBounds();

        if (selectedLoop) {
          const pageDur = this._pageDuration();
          const targetTime = opts?.scrollToEnd ? selectedLoop.endTime : selectedLoop.startTime;
          this._sheetCurrentPage = Math.max(
            0,
            Math.min(Math.floor(targetTime / pageDur), this._sheetPageCount() - 1),
          );
        }

        this.renderSheetPage();
      }
    };

    this._loopsPanel = new LoopsPanel(game, {
      setMode: (learning) => this._deps.setMode(learning),
      onMutated: onLoopsMutated,
    });

    const openSheetBtn = document.getElementById(BTN_OPEN_SHEET_ID)!;
    this._sheetScreen = document.getElementById(SHEET_SCREEN_ID)!;
    this._sheetCanvas = document.getElementById(SHEET_CANVAS_ID) as HTMLCanvasElement;
    this._sheetRenderer = new Renderer(this._sheetCanvas);
    this._sheetPrevBtn = document.getElementById(BTN_SHEET_PREV_ID)!;
    this._sheetNextBtn = document.getElementById(BTN_SHEET_NEXT_ID)!;
    const sheetCloseBtn = document.getElementById(BTN_CLOSE_SHEET_ID)!;
    this._sheetPageInfo = document.getElementById(SHEET_PAGE_INFO_ID)!;
    this._sheetHint = document.getElementById(SHEET_HINT_ID)!;
    const defineLoopBtn = document.getElementById(BTN_DEFINE_LOOP_ID)!;
    const addLoopBtn = document.getElementById(BTN_ADD_LOOP_ID)! as HTMLButtonElement;

    openSheetBtn.addEventListener('click', () => {
      if (this._game.state === GameState.Playing) this.toggleSheetView();
    });

    sheetCloseBtn.addEventListener('click', () => this.closeSheetView());

    this._sheetPrevBtn.addEventListener('click', () => {
      if (this._sheetCurrentPage > 0) {
        this._sheetCurrentPage--;
        this.renderSheetPage();
      }
    });

    this._sheetNextBtn.addEventListener('click', () => {
      if (this._sheetCurrentPage < this._sheetPageCount() - 1) {
        this._sheetCurrentPage++;
        this.renderSheetPage();
      }
    });

    this._sheetCanvas.addEventListener('click', (e) =>
      this._handleCanvasClick(e, this._sheetCanvas, this._sheetRenderer),
    );

    defineLoopBtn.addEventListener('click', () => {
      if (!this._game.learningMode) this._deps.setMode(true);
      const noLoops = this._game.loop.loops.length === 0;

      if (noLoops) this._game.beginLoopDefine();
      this._deps.updateLoopUI();

      if (this._game.state === GameState.Playing) {
        this.openSheetView();
        this._startSheetRAF();
      }
    });

    addLoopBtn.addEventListener('click', () => {
      this._game.beginLoopDefine();
      this._deps.updateLoopUI();
      this._loopsPanel.render();

      if (this._sheetOpen) this.renderSheetPage();
    });

    const resizeHandle = document.getElementById(SHEET_RESIZE_HANDLE_ID)!;
    let resizing = false;
    let resizeRAF = false;

    resizeHandle.addEventListener('pointerdown', (e) => {
      resizing = true;
      resizeHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    window.addEventListener('pointermove', (e) => {
      if (!resizing || resizeRAF) return;

      if (this._game.state !== GameState.Playing) return;
      resizeRAF = true;
      requestAnimationFrame(() => {
        const rect = this._canvas.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const minSheetHeight = BASE_SHEET_HEIGHT * 0.5;
        const maxSheetHeight = this._canvas.height * 0.35;
        const targetHeight = Math.max(
          minSheetHeight,
          Math.min(maxSheetHeight, y - SHEET_TOP_OFFSET),
        );
        this._game.renderer.sheetScale = targetHeight / BASE_SHEET_HEIGHT;
        resizeRAF = false;
      });
    });

    window.addEventListener('pointerup', () => {
      resizing = false;
    });

    this._canvas.addEventListener('click', (e) =>
      this._handleCanvasClick(e, this._canvas, this._game.renderer),
    );

    document.addEventListener('keydown', (e) => {
      if (!this._sheetOpen) return;

      if (e.code === 'ArrowLeft') {
        e.preventDefault();

        if (this._sheetCurrentPage > 0) {
          this._sheetCurrentPage--;
          this.renderSheetPage();
        }
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();

        if (this._sheetCurrentPage < this._sheetPageCount() - 1) {
          this._sheetCurrentPage++;
          this.renderSheetPage();
        }
      } else if (e.code === 'Escape') {
        e.preventDefault();
        this.closeSheetView();
      }
    });

    this._sheetScreen.addEventListener('click', (e) => {
      if (e.target === this._sheetScreen) this.closeSheetView();
    });

    setupHoverCursor(this._game, this._sheetCanvas, this._sheetRenderer);
  }

  closeSheetView(): void {
    this._sheetOpen = false;
    this._sheetScreen.classList.remove('active');
  }

  private _pageDuration(): number {
    return SHEET_BEATS_VISIBLE * (60 / this._game.songBpm);
  }

  private _sheetPageCount(): number {
    return Math.max(1, Math.ceil(this._game.noteManager.getSongDuration() / this._pageDuration()));
  }

  private _getSelectedLoopBounds(): { startTime: number; endTime: number } | undefined {
    if (this._loopsPanel.selectedId === null) return undefined;
    const loop = this._game.loop.loops.find((l) => l.id === this._loopsPanel.selectedId);

    if (!loop) return undefined;

    return { startTime: loop.startTime, endTime: loop.endTime };
  }

  renderSheetPage(): void {
    if (!this._sheetOpen) return;
    const ctx = this._sheetRenderer.ctx;
    // The context is scaled by PIXEL_RENDER_SCALE, so clear in CSS units —
    // canvas.width/height are device pixels and would only wipe the
    // top-left quarter, leaving stale pixels from the previous page.
    ctx.clearRect(0, 0, this._sheetRenderer.width, this._sheetRenderer.height);
    const start = this._sheetCurrentPage * this._pageDuration();
    const end = Math.min(start + this._pageDuration(), this._game.noteManager.getSongDuration());

    const selectedLoop = this._getSelectedLoopBounds();

    this._sheetRenderer.drawSheetMusic(
      this._game.noteManager.trebleNotes,
      this._game.noteManager.bassNotes,
      this._game.currentTime,
      this._game.noteManager.getSongDuration(),
      this._game.loop.snapshot(),
      { start, end },
      this._game.songBpm,
      selectedLoop,
    );

    this._sheetPageInfo.textContent = `${this._sheetCurrentPage + 1} / ${this._sheetPageCount()}`;
    this._sheetPrevBtn.toggleAttribute('disabled', this._sheetCurrentPage <= 0);
    this._sheetNextBtn.toggleAttribute(
      'disabled',
      this._sheetCurrentPage >= this._sheetPageCount() - 1,
    );

    const phase = this._game.loopDefinitionState;

    if (phase === LoopDefinitionState.Start) {
      this._sheetHint.textContent = 'Click the start note';
    } else if (phase === LoopDefinitionState.End) {
      this._sheetHint.textContent = 'Click the end note';
    } else {
      this._sheetHint.textContent = 'Click a note to resume there';
    }
  }

  private _jumpSheetToCurrent(): void {
    const dur = this._game.noteManager.getSongDuration();
    this._sheetCurrentPage =
      dur <= 0
        ? 0
        : Math.min(
            Math.floor(this._game.currentTime / this._pageDuration()),
            this._sheetPageCount() - 1,
          );

    if (this._sheetCurrentPage < 0) this._sheetCurrentPage = 0;
    this.renderSheetPage();
  }

  openSheetView(jumpToCurrent = true): void {
    if (this._sheetOpen) {
      if (jumpToCurrent) this._jumpSheetToCurrent();
      else this.renderSheetPage();
      this._loopsPanel.render();

      return;
    }

    this._sheetOpen = true;
    const cur = this._game.loop.current;
    this._loopsPanel.select(cur ? cur.id : null);
    this._sheetScreen.classList.add('active');
    this._sheetRenderer.resize();
    this._sheetRenderer.sheetScale = Math.max(this._sheetRenderer.sheetScale, 1.5);
    this._loopsPanel.render();

    if (jumpToCurrent) this._jumpSheetToCurrent();
    else this.renderSheetPage();
  }

  toggleSheetView(): void {
    if (this._sheetOpen) this.closeSheetView();
    else this.openSheetView();
  }

  private _noteFromClick(
    rect: DOMRect,
    clientX: number,
    clientY: number,
    renderer: Renderer,
    maxRadius = 30,
  ): SongNote | null {
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const r = renderer;

    if (r.sheetBarW <= 0) return null;

    if (x < r.sheetBarX - maxRadius || x > r.sheetBarX + r.sheetBarW + maxRadius) return null;

    return this._game.noteManager.findNearestNoteByClick(x, y, r, maxRadius);
  }

  private async _handleCanvasClick(
    e: MouseEvent,
    targetCanvas: HTMLCanvasElement,
    renderer: Renderer,
  ): Promise<void> {
    if (this._game.state !== GameState.Playing) return;

    const inLoopDefine =
      this._game.loopDefinitionState === LoopDefinitionState.Start ||
      this._game.loopDefinitionState === LoopDefinitionState.End;

    const note = this._noteFromClick(
      targetCanvas.getBoundingClientRect(),
      e.clientX,
      e.clientY,
      renderer,
      inLoopDefine ? 50 : 30,
    );

    if (!note) return;

    if (inLoopDefine) {
      const newState = this._game.setLoopBoundary(note.time);
      this._deps.updateLoopUI();
      this._loopsPanel.render();

      if (targetCanvas === this._sheetCanvas) this.renderSheetPage();

      if (newState === LoopDefinitionState.Off && this._game.loop.hasDraft) {
        const song = this._game.song;

        if (!song || song.id === undefined) return;
        const ds = this._game.loop.draftStart!;
        const de = this._game.loop.draftEnd!;

        try {
          const created = await createLoop(song.id, ds, de, true);
          this._game.cancelLoopDraft();
          this._game.addSavedLoop(created);

          if (this._game.loopActive && !this._game.learningMode) this._deps.setMode(true);
          this._loopsPanel.render();
          this._deps.updateLoopUI();

          if (this._sheetOpen) this.renderSheetPage();
        } catch (err) {
          reportError('Failed to auto-save loop', err);
        }
      }
    } else {
      this._game.seekTo(note.time);

      if (targetCanvas !== this._canvas) this.closeSheetView();
    }
  }

  private _sheetRAFLoop(): void {
    if (!this._sheetOpen || this._game.state !== GameState.Playing) {
      this.closeSheetView();
      this._sheetRAF = null;

      return;
    }

    this.renderSheetPage();

    if (this._lastPanelRenderLoopId !== this._game.loop.currentIndex) {
      this._lastPanelRenderLoopId = this._game.loop.currentIndex;
      this._loopsPanel.render();
    }

    this._sheetRAF = requestAnimationFrame(() => this._sheetRAFLoop());
  }

  private _startSheetRAF(): void {
    if (this._sheetRAF === null) this._sheetRAF = requestAnimationFrame(() => this._sheetRAFLoop());
  }
}
