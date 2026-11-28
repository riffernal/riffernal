// Main canvas renderer: highway, notes, sheet music, particles,
// and playback cursor. Delegates piano rendering to PianoRenderer.

import {
  NOTE_NAMES,
  getPianoKeyLayout,
  WHITE_KEY_COUNT,
  handColor,
  HandSide,
  NOTE_SHORT_NAMES,
  whiteKeyWidth,
  countWhiteKeysInRange,
} from '../../utils/notes.js';
import type { PianoKeyLayout, VisibleRange } from '../../utils/notes.js';
import { HIT_ZONE_Y_RATIO } from '../NoteManager.js';
import { LoopDefinitionState } from '../Loop.js';
import { PianoRenderer, INDICATOR_BAR_OFFSET } from './PianoRenderer.js';
import type { SongNote } from '../NoteManager.js';
import { isLowEndDevice } from '../../utils/device.js';
import { themeManager } from '../../themes/ThemeManager.js';
import { velocityIntensity } from '../../utils/helpers.js';

export const SHEET_TOP_OFFSET = 84;

const HIGHWAY_BELOW_HIT_ZONE = 14;
const CLEF_WIDTH = 25;
const SHEET_MARGIN = 8;
const STAFF_TOP_PADDING = 5;
const STAFF_GAP = 24;
const STAFF_BOTTOM_PADDING = 5;
/** Fraction of CSS resolution canvases render at; the browser upscales
 *  with image-rendering: pixelated for the retro pixel look. */
const PIXEL_RENDER_SCALE = 0.5;

export const CLEF_TYPES = {
  BASS: 'bass',
  TREBLE: 'treble',
} as const;

function diatonicStaffPositions(reference: string): Record<string, number> {
  const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const index = (name: string): number => {
    const match = name.match(/^([A-G])(\d)$/)!;
    return parseInt(match[2], 10) * letters.length + letters.indexOf(match[1]);
  };
  const referenceIndex = index(reference);
  return Object.fromEntries(
    NOTE_NAMES.map((name) => [name, index(name.replace('#', '')) - referenceIndex]),
  );
}

export const BASS_STAFF_POSITIONS = diatonicStaffPositions('G2');

export const TREBLE_STAFF_POSITIONS = diatonicStaffPositions('E4');

export const NOTE_TO_CLEF: Record<string, string> = {
  A0: CLEF_TYPES.BASS,
  'A#0': CLEF_TYPES.BASS,
  B0: CLEF_TYPES.BASS,
  C1: CLEF_TYPES.BASS,
  'C#1': CLEF_TYPES.BASS,
  D1: CLEF_TYPES.BASS,
  'D#1': CLEF_TYPES.BASS,
  E1: CLEF_TYPES.BASS,
  F1: CLEF_TYPES.BASS,
  'F#1': CLEF_TYPES.BASS,
  G1: CLEF_TYPES.BASS,
  'G#1': CLEF_TYPES.BASS,
  A1: CLEF_TYPES.BASS,
  'A#1': CLEF_TYPES.BASS,
  B1: CLEF_TYPES.BASS,
  C2: CLEF_TYPES.BASS,
  'C#2': CLEF_TYPES.BASS,
  D2: CLEF_TYPES.BASS,
  'D#2': CLEF_TYPES.BASS,
  E2: CLEF_TYPES.BASS,
  F2: CLEF_TYPES.BASS,
  'F#2': CLEF_TYPES.BASS,
  G2: CLEF_TYPES.BASS,
  'G#2': CLEF_TYPES.BASS,
  A2: CLEF_TYPES.BASS,
  'A#2': CLEF_TYPES.BASS,
  B2: CLEF_TYPES.BASS,
  C3: CLEF_TYPES.BASS,
  'C#3': CLEF_TYPES.BASS,
  D3: CLEF_TYPES.BASS,
  'D#3': CLEF_TYPES.BASS,
  E3: CLEF_TYPES.BASS,
  F3: CLEF_TYPES.BASS,
  'F#3': CLEF_TYPES.BASS,
  G3: CLEF_TYPES.BASS,
  'G#3': CLEF_TYPES.BASS,
  A3: CLEF_TYPES.BASS,
  'A#3': CLEF_TYPES.BASS,
  B3: CLEF_TYPES.BASS,
  C4: CLEF_TYPES.TREBLE,
  'C#4': CLEF_TYPES.TREBLE,
  D4: CLEF_TYPES.TREBLE,
  'D#4': CLEF_TYPES.TREBLE,
  E4: CLEF_TYPES.TREBLE,
  F4: CLEF_TYPES.TREBLE,
  'F#4': CLEF_TYPES.TREBLE,
  G4: CLEF_TYPES.TREBLE,
  'G#4': CLEF_TYPES.TREBLE,
  A4: CLEF_TYPES.TREBLE,
  'A#4': CLEF_TYPES.TREBLE,
  B4: CLEF_TYPES.TREBLE,
  C5: CLEF_TYPES.TREBLE,
  'C#5': CLEF_TYPES.TREBLE,
  D5: CLEF_TYPES.TREBLE,
  'D#5': CLEF_TYPES.TREBLE,
  E5: CLEF_TYPES.TREBLE,
  F5: CLEF_TYPES.TREBLE,
  'F#5': CLEF_TYPES.TREBLE,
  G5: CLEF_TYPES.TREBLE,
  'G#5': CLEF_TYPES.TREBLE,
  A5: CLEF_TYPES.TREBLE,
  'A#5': CLEF_TYPES.TREBLE,
  B5: CLEF_TYPES.TREBLE,
  C6: CLEF_TYPES.TREBLE,
  'C#6': CLEF_TYPES.TREBLE,
  D6: CLEF_TYPES.TREBLE,
  'D#6': CLEF_TYPES.TREBLE,
  E6: CLEF_TYPES.TREBLE,
  F6: CLEF_TYPES.TREBLE,
  'F#6': CLEF_TYPES.TREBLE,
  G6: CLEF_TYPES.TREBLE,
  'G#6': CLEF_TYPES.TREBLE,
  A6: CLEF_TYPES.TREBLE,
  'A#6': CLEF_TYPES.TREBLE,
  B6: CLEF_TYPES.TREBLE,
  C7: CLEF_TYPES.TREBLE,
  'C#7': CLEF_TYPES.TREBLE,
  D7: CLEF_TYPES.TREBLE,
  'D#7': CLEF_TYPES.TREBLE,
  E7: CLEF_TYPES.TREBLE,
  F7: CLEF_TYPES.TREBLE,
  'F#7': CLEF_TYPES.TREBLE,
  G7: CLEF_TYPES.TREBLE,
  'G#7': CLEF_TYPES.TREBLE,
  A7: CLEF_TYPES.TREBLE,
  'A#7': CLEF_TYPES.TREBLE,
  B7: CLEF_TYPES.TREBLE,
  C8: CLEF_TYPES.TREBLE,
};

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  life: number;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface GrindBeam {
  lane: number;
  rgb: RGB;
  endTime: number;
  startMs: number;
}

interface GrindFlash {
  lane: number;
  rgb: RGB;
  startMs: number;
}

const SHEET_STAFF_LINE_SPACING = 10;
const SHEET_BASE_HEIGHT = 5 + 4 * SHEET_STAFF_LINE_SPACING + STAFF_GAP + 4 * SHEET_STAFF_LINE_SPACING + 5;
const SHEET_NOTE_RADIUS = 4.5;
export const SHEET_BEATS_VISIBLE = 18;
const STANDARD_NOTATION_BEATS_VISIBLE = 8;
const STANDARD_NOTATION_MAX_SCALE = 3;
const SHEET_BEATS_PER_MEASURE = 4;

// Size of one "big pixel" on the highway. All note rects snap to this grid,
// which is what makes notes read as chunky blocks instead of smooth shapes.
const NOTE_PIXEL = 3;

function pixelSnap(v: number, unit: number): number {
  return Math.round(v / unit) * unit;
}

function pixelRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  unit: number,
): void {
  x = pixelSnap(x, unit);
  y = pixelSnap(y, unit);
  w = Math.max(unit, pixelSnap(w, unit));
  h = Math.max(unit, pixelSnap(h, unit));
  ctx.fillRect(x, y, w, h);
}

// Block with a hard border, drawn as two rects so the outline is
// `borderUnit` thick on every side. Position snaps to `snapUnit`, kept
// separate from the border thickness.
function pixelBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  snapUnit: number,
  borderUnit: number,
  borderColor: string,
  fillColor: string,
): void {
  ctx.fillStyle = borderColor;
  pixelRect(ctx, x - borderUnit, y - borderUnit, w + borderUnit * 2, h + borderUnit * 2, snapUnit);
  ctx.fillStyle = fillColor;
  pixelRect(ctx, x, y, w, h, snapUnit);
}

const SHEET_NOTE_POSITIONS: Record<string, number> = Object.assign(
  BASS_STAFF_POSITIONS,
  TREBLE_STAFF_POSITIONS,
);

const TAIL_HIGHLIGHT_ALPHA = 0.1;
const HEAD_HIGHLIGHT_ALPHA = 0.28;

const GRIND_FLASH_MS = 320;
const GRIND_FLASH_HEIGHT = 140;
const GRIND_FLASH_SPARKS = 14;
const GRIND_FLASH_SEGMENTS = 8;
const GRIND_BEAM_SEGMENTS = 18;
const GRIND_JAGGER = 0.32;
const GRIND_BEAM_RAMP_MS = 260;
const LANE_GLOW_HEIGHT = 220;
const GRIND_BEAM_SCROLL_PX_PER_SEC = 400;
const MAX_GRIND_FLASHES = 12;
const GRIND_HIGHLIGHT_COLOR = '#ffffff';

const FLAME_COLORS = [
  { stop: 0, color: 'rgba(255, 210, 70, 0.9)' },
  { stop: 0.25, color: 'rgba(255, 140, 30, 0.55)' },
  { stop: 0.6, color: 'rgba(255, 70, 0, 0.2)' },
  { stop: 1, color: 'rgba(200, 30, 0, 0)' },
] as const;

const FLAME_CORE_COLORS = [
  { stop: 0, color: 'rgba(255, 245, 200, 0.85)' },
  { stop: 0.5, color: 'rgba(255, 200, 100, 0.3)' },
  { stop: 1, color: 'rgba(255, 180, 60, 0)' },
] as const;

interface NoteLayout {
  drawX: number;
  drawY: number;
  scaledWidth: number;
  scaledHeadHeight: number;
  scaledTailHeight: number;
  baseWidth: number;
}

interface SheetLayout {
  ctx: CanvasRenderingContext2D;
  sheetTop: number;
  sheetBottom: number;
  barX: number;
  barW: number;
  viewStart: number;
  viewEnd: number;
  staffLineSpacing: number;
  scale: number;
  beatsPerSecond: number;
}

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  pressedKeys = new Set<string>();
  particles: Particle[] = [];
  private _grindBeams = new Map<number, GrindBeam>();
  private _grindFlashes: GrindFlash[] = [];
  private _glowGradCache = new Map<
    number,
    { top: number; bottom: number; rgb: RGB; intensity: number; grad: CanvasGradient }
  >();
  sheetBottom = 0;
  sheetScale = 1.0;
  sheetBarX = 0;
  sheetBarW = 0;
  sheetViewStart = 0;
  sheetViewEnd = 0;
  standardNotation = false;
  sheetTrebleTop = 0;
  sheetTrebleBottom = 0;
  sheetBassTop = 0;
  sheetBassBottom = 0;
  private _activeSheetScale = 1;
  piano: PianoRenderer;
  private _staffCache: HTMLCanvasElement | null = null;
  private _cachedStaffScale = -1;
  private _cachedStaffWidth = -1;
  private _cachedStaffTop = -1;
  private _cachedStaffBottom = -1;
  private _labelFontCache = new Map<string, string>();
  private _labelTextWidth = new Map<string, number>();
  private _labelFontUi = '';
  private _flameSprites: { outer: HTMLCanvasElement; core: HTMLCanvasElement } | null = null;
  private _haloGrad: CanvasGradient | null = null;
  private _haloKey = '';

  private _now = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.piano = new PianoRenderer();
    this.resize();
  }

  resize(): void {
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(1, Math.floor(cssW * PIXEL_RENDER_SCALE));
    this.canvas.height = Math.max(1, Math.floor(cssH * PIXEL_RENDER_SCALE));
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(PIXEL_RENDER_SCALE, PIXEL_RENDER_SCALE);
    this.width = cssW;
    this.height = cssH;
    this._glowGradCache.clear();
    this._haloGrad = null;
  }

  clear(): void {
    this.ctx.fillStyle = themeManager.canvas.bg;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  beginFrame(nowMs: number): void {
    this._now = nowMs;
  }

  setStandardNotation(enabled: boolean): void {
    this.standardNotation = enabled;
    this.sheetBottom = enabled ? this._standardNotationBottom() : 0;
  }

  private _standardNotationBottom(): number {
    return this.height - this.height * 0.16 - 12;
  }

  pianoKeyLayout(
    noteName: string,
    visibleRange?: VisibleRange | null,
  ): PianoKeyLayout & { y: number; height: number } {
    const layout = getPianoKeyLayout(noteName, this.width, visibleRange);
    const pianoHeight = this.height * 0.16;
    return {
      ...layout,
      y: this.height - pianoHeight,
      height: layout.isBlack ? pianoHeight * 0.56 : pianoHeight,
    };
  }

  drawHighway(
    _scrollOffset: number,
    pressedLanes: Map<number, number>,
    visibleRange?: VisibleRange | null,
  ): void {
    const ctx = this.ctx;
    const c = themeManager.canvas;
    const hitZoneY = this.height * HIT_ZONE_Y_RATIO;
    const highwayTop = 0;
    const highwayBottom = hitZoneY + HIGHWAY_BELOW_HIT_ZONE;
    const keyWidth = whiteKeyWidth(this.width, visibleRange);

    ctx.fillStyle = c.highwayBg;
    ctx.fillRect(0, highwayTop, this.width, highwayBottom - highwayTop);

    ctx.strokeStyle = c.highwayLane;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const laneCount = visibleRange ? countWhiteKeysInRange(visibleRange) : WHITE_KEY_COUNT;
    for (let i = 1; i < laneCount; i++) {
      const x = i * keyWidth;
      ctx.moveTo(x, highwayTop);
      ctx.lineTo(x, highwayBottom);
    }
    ctx.stroke();

    const sheetBottom = Math.max(this.sheetBottom, 0);
    const glowTop = Math.max(sheetBottom, hitZoneY - LANE_GLOW_HEIGHT);

    if (pressedLanes.size > 0) {
      for (const [lane, velocity] of pressedLanes) {
        const noteName = NOTE_NAMES[lane];
        if (!noteName) continue;
        const layout = getPianoKeyLayout(noteName, this.width, visibleRange);
        if (layout.width === 0) continue;
        const intensity = velocityIntensity(velocity);
        const color = handColor(noteName);
        const cx = layout.x + layout.width / 2;
        const colW = layout.width * (0.55 + 0.45 * intensity);
        const grad = this._laneGlowGrad(lane, color, glowTop, hitZoneY, intensity);
        ctx.fillStyle = grad;
        ctx.fillRect(cx - colW / 2, glowTop, colW, hitZoneY - glowTop);
      }
    }

    // The halo only moves when the hit zone moves (resize) or the theme
    // hit-line color changes, so build the gradient once for each state.
    const haloKey = `${hitZoneY}|${c.hitLine}`;
    if (!this._haloGrad || this._haloKey !== haloKey) {
      const grad = ctx.createLinearGradient(0, hitZoneY - 10, 0, hitZoneY + 10);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.5, this._withAlpha(c.hitLine, 0.5));
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      this._haloGrad = grad;
      this._haloKey = haloKey;
    }
    ctx.fillStyle = this._haloGrad;
    ctx.fillRect(0, hitZoneY - 10, this.width, 20);

    ctx.strokeStyle = c.hitLine;
    ctx.lineWidth = 3;
    if (!isLowEndDevice()) {
      ctx.shadowColor = c.hitLine;
      ctx.shadowBlur = 16;
    }
    ctx.beginPath();
    ctx.moveTo(0, hitZoneY);
    ctx.lineTo(this.width, hitZoneY);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  private _parseRgb(color: string): RGB {
    if (!color.startsWith('#')) return { r: 0, g: 0, b: 0 };
    const hex = color.slice(1);
    const r = parseInt(hex.length === 3 ? hex[0] + hex[0] : hex.slice(0, 2), 16);
    const g = parseInt(hex.length === 3 ? hex[1] + hex[1] : hex.slice(2, 4), 16);
    const b = parseInt(hex.length === 3 ? hex[2] + hex[2] : hex.slice(4, 6), 16);
    return { r, g, b };
  }

  private _rgba(rgb: RGB, alpha: number): string {
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  private _withAlpha(color: string, alpha: number): string {
    return this._rgba(this._parseRgb(color), alpha);
  }

  private _laneGlowGrad(
    lane: number,
    color: string,
    top: number,
    bottom: number,
    intensity: number,
  ): CanvasGradient {
    const rgb = this._parseRgb(color);
    const entry = this._glowGradCache.get(lane);
    if (
      entry &&
      entry.top === top &&
      entry.bottom === bottom &&
      entry.intensity === intensity &&
      entry.rgb.r === rgb.r &&
      entry.rgb.g === rgb.g &&
      entry.rgb.b === rgb.b
    ) {
      return entry.grad;
    }
    const grad = this.ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, this._rgba(rgb, 0.22 * intensity));
    this._glowGradCache.set(lane, { top, bottom, rgb, intensity, grad });
    return grad;
  }

  drawHitZone(pressedLanes: Map<number, number>, visibleRange?: VisibleRange | null): void {
    this.piano.drawHitZone(
      this.ctx,
      this.width,
      this.height,
      pressedLanes,
      visibleRange,
      this._now,
    );
  }

  drawPiano(pressedLanes: Map<number, number>, visibleRange?: VisibleRange | null): void {
    this.piano.drawPiano(this.ctx, this.width, this.height, pressedLanes, visibleRange, this._now);
  }

  /** Learn-mode teaching aid: light up the piano key the player pressed
   *  incorrectly. The flash fades out over the next frames. */
  flashWrongKey(lane: number): void {
    this.piano.flashWrongKey(lane, performance.now());
  }

  notePixelPosition(note: SongNote): { x: number; y: number } | null {
    if (this.sheetBarW <= 0) return null;
    const { sheetBarX: barX, sheetBarW: barW, sheetViewStart: vs, sheetViewEnd: ve } = this;
    if (note.time < vs || note.time > ve) return null;

    const staffLineSpacing = SHEET_STAFF_LINE_SPACING * this._activeSheetScale;
    const pos = SHEET_NOTE_POSITIONS[note.key];
    if (pos === undefined) return null;

    const staffTop = note.hand === HandSide.Left ? this.sheetBassTop : this.sheetTrebleTop;
    const x = barX + ((note.time - vs) / (ve - vs)) * barW;
      const y = staffTop + (8 - pos) * (staffLineSpacing / 2);

    return { x, y };
  }

  private _noteLayout(
    laneIndex: number,
    y: number,
    noteHeight: number,
    noteName?: string,
    visibleRange?: VisibleRange | null,
  ): NoteLayout {
    const layout = getPianoKeyLayout(
      noteName ?? NOTE_NAMES[laneIndex] ?? 'C4',
      this.width,
      visibleRange,
    );
    const keyWidth = layout.width;
    const centerX = layout.x + keyWidth / 2;

    const headBottom = y + noteHeight;

    // One constant silhouette for the whole fall. The visible box (fill +
    // NOTE_PIXEL border per side) snaps DOWN to the key width's grid
    // multiple, so it always fits inside its key — black-key notes included,
    // proportionally narrower than white-key notes, like the keys themselves.
    const HEAD_HEIGHT = 15;
    const scaledHeadHeight = HEAD_HEIGHT;
    const scaledTailHeight = Math.max(0, noteHeight - scaledHeadHeight);
    const outerWidth = Math.floor(keyWidth / NOTE_PIXEL) * NOTE_PIXEL;
    const scaledWidth = Math.max(0, outerWidth - NOTE_PIXEL * 2);
    const drawX = centerX - outerWidth / 2 + NOTE_PIXEL;

    // The note docks its visible bottom edge (fill bottom + border) onto the
    // indicator bar's bottom edge, not the hit line: the bar sits
    // INDICATOR_BAR_OFFSET above the line and the border extends NOTE_PIXEL
    // below the fill, so lift the whole note by their sum. Held notes then
    // rest flush on the bar instead of hanging below it.
    const dockLift = NOTE_PIXEL + INDICATOR_BAR_OFFSET;
    const parkedHeadBottom = headBottom - dockLift;

    return {
      drawX,
      drawY: parkedHeadBottom - scaledHeadHeight - scaledTailHeight,
      scaledWidth,
      scaledHeadHeight,
      scaledTailHeight,
      baseWidth: keyWidth,
    };
  }

  private _drawNotePart(
    ctx: CanvasRenderingContext2D,
    drawX: number,
    drawY: number,
    w: number,
    h: number,
    snapUnit: number,
    borderUnit: number,
    fillColor: string,
    borderColor: string,
  ): void {
    pixelBox(ctx, drawX, drawY, w, h, snapUnit, borderUnit, borderColor, fillColor);
  }

  drawNote(
    laneIndex: number,
    y: number,
    noteHeight: number,
    color: string,
    alpha: number,
    _combo: number,
    noteName?: string,
    holding?: boolean,
    waiting?: boolean,
    visibleRange?: VisibleRange | null,
  ): void {
    const ctx = this.ctx;
    const c = themeManager.canvas;
    const L = this._noteLayout(laneIndex, y, noteHeight, noteName, visibleRange);

    ctx.globalAlpha = alpha;

    const borderColor = 'rgba(0, 0, 0, 0.55)';

    const snapUnit = NOTE_PIXEL;
    const borderUnit = NOTE_PIXEL;

    if (waiting) {
      const pulse = 0.5 + 0.5 * Math.sin((this._now / 200) * 3.2);
      const glowUnits = Math.max(borderUnit, pixelSnap(4 + pulse * 8, snapUnit));
      ctx.globalAlpha = alpha * 0.25;
      ctx.fillStyle = color;
      pixelRect(
        ctx,
        L.drawX - glowUnits,
        L.drawY - glowUnits,
        L.scaledWidth + glowUnits * 2,
        L.scaledHeadHeight + L.scaledTailHeight + glowUnits * 2,
        snapUnit,
      );
      ctx.globalAlpha = alpha;
    }

    if (L.scaledTailHeight > 0.5) {
      this._drawNotePart(
        ctx,
        L.drawX,
        L.drawY,
        L.scaledWidth,
        L.scaledTailHeight,
        snapUnit,
        borderUnit,
        color,
        borderColor,
      );
      ctx.globalAlpha = alpha * TAIL_HIGHLIGHT_ALPHA;
      ctx.fillStyle = c.noteHighlight;
      pixelRect(ctx, L.drawX, L.drawY, L.scaledWidth, L.scaledTailHeight, snapUnit);
      ctx.globalAlpha = alpha;
    }

    const headDrawY = L.drawY + L.scaledTailHeight;
    this._drawNotePart(
      ctx,
      L.drawX,
      headDrawY,
      L.scaledWidth,
      L.scaledHeadHeight,
      snapUnit,
      borderUnit,
      color,
      borderColor,
    );
    ctx.globalAlpha = alpha * HEAD_HIGHLIGHT_ALPHA;
    ctx.fillStyle = c.noteHighlight;
    pixelRect(ctx, L.drawX, headDrawY, L.scaledWidth, L.scaledHeadHeight, snapUnit);
    ctx.globalAlpha = alpha;

    if (holding) {
      const cx = L.drawX + L.scaledWidth / 2;
      const baseY = headDrawY + L.scaledHeadHeight / 2;
      this._drawFlame(ctx, cx, baseY, L.scaledWidth);
    }

    if (noteName) {
      this._drawNoteBadge(
        ctx,
        noteName,
        L.drawX + L.scaledWidth / 2,
        headDrawY + L.scaledHeadHeight,
        color,
        L.baseWidth,
      );
    }

    ctx.globalAlpha = 1;
  }

  /** Every named note carries a name badge anchored at the head's
   *  leading edge, sized from the lane width and screen height so it
   *  reads big on any window size. Press Start 2P fills its em box, so
   *  the name stays legible where the condensed VT323 would look small.
   *  The badge is its own box — dark fill, note-border color, white
   *  text. */
  private _drawNoteBadge(
    ctx: CanvasRenderingContext2D,
    noteName: string,
    centerX: number,
    bottomY: number,
    borderColor: string,
    noteWidth: number,
  ): void {
    const shortName = NOTE_SHORT_NAMES[noteName] ?? noteName;
    const fontSize = Math.round(Math.min(Math.max(12, noteWidth * 0.55), 24));
    const ui = themeManager.fonts.ui;
    if (ui !== this._labelFontUi) {
      this._labelFontUi = ui;
      this._labelFontCache.clear();
      this._labelTextWidth.clear();
    }
    const badgeKey = `ui:${fontSize}`;
    let font = this._labelFontCache.get(badgeKey);
    if (!font) {
      font = `${fontSize}px ${ui}`;
      this._labelFontCache.set(badgeKey, font);
    }
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // measureText per named note per frame adds up in chords; the width
    // only varies with font + text, so memoize both.
    const textKey = `${fontSize}|${shortName}`;
    let textW = this._labelTextWidth.get(textKey);
    if (textW === undefined) {
      textW = ctx.measureText(shortName).width;
      this._labelTextWidth.set(textKey, textW);
    }
    const bw = pixelSnap(textW + fontSize * 0.45, NOTE_PIXEL);
    const bh = pixelSnap(fontSize + 18, NOTE_PIXEL);
    const bx = pixelSnap(centerX - bw / 2, NOTE_PIXEL);
    const by = pixelSnap(bottomY - bh, NOTE_PIXEL);
    pixelBox(ctx, bx, by, bw, bh, NOTE_PIXEL, NOTE_PIXEL, borderColor, 'rgba(0, 0, 0, 0.88)');
    ctx.fillStyle = '#fff';
    ctx.fillText(shortName, bx + bw / 2, by + bh / 2 + 1);
  }

  /** The two flame layers as pre-rendered sprites: dense chords keep many
   *  holds lit at once, and building two radial gradients per held note per
   *  frame is measurably slower than blitting scaled sprites. Each sprite
   *  spans a 128px square (large enough to stay crisp when upscaled to wide
   *  notes) with the gradient's full extent reaching the edge (outer stops
   *  at alpha 0), so uniform scaling reproduces the gradient. */
  private _ensureFlameSprites(): void {
    if (this._flameSprites) return;
    const R = 64;
    const make = (stops: readonly { stop: number; color: string }[]): HTMLCanvasElement => {
      const sprite = document.createElement('canvas');
      sprite.width = R * 2;
      sprite.height = R * 2;
      const sctx = sprite.getContext('2d')!;
      const grad = sctx.createRadialGradient(R, R, 0, R, R, R);
      for (const { stop, color } of stops) {
        grad.addColorStop(stop, color);
      }
      sctx.fillStyle = grad;
      sctx.fillRect(0, 0, R * 2, R * 2);
      return sprite;
    };
    this._flameSprites = { outer: make(FLAME_COLORS), core: make(FLAME_CORE_COLORS) };
  }

  private _drawFlame(
    ctx: CanvasRenderingContext2D,
    cx: number,
    baseY: number,
    width: number,
  ): void {
    this._ensureFlameSprites();
    const t = this._now / 1000;
    const pulse = 0.8 + 0.2 * Math.sin(t * 5);

    const r = width * 2.0 * pulse;
    ctx.drawImage(this._flameSprites!.outer, cx - r, baseY - r, r * 2, r * 2);

    const r2 = width * 0.7;
    ctx.drawImage(this._flameSprites!.core, cx - r2, baseY - r2, r2 * 2, r2 * 2);
  }

  // -- Grind effect (Guitar-Hero-style electric trail) --------------------

  triggerGrindFlash(lane: number, color: string): void {
    if (this._grindFlashes.length >= MAX_GRIND_FLASHES) {
      this._grindFlashes.shift();
    }
    this._grindFlashes.push({ lane, rgb: this._parseRgb(color), startMs: this._now });
  }

  startGrindBeam(lane: number, color: string, endTime: number): void {
    this._grindBeams.set(lane, { lane, rgb: this._parseRgb(color), endTime, startMs: this._now });
  }

  endGrindBeam(lane: number): void {
    this._grindBeams.delete(lane);
  }

  clearGrind(): void {
    this._grindBeams.clear();
    this._grindFlashes.length = 0;
  }

  drawGrind(currentTime: number, visibleRange?: VisibleRange | null): void {
    const ctx = this.ctx;
    const hitZoneY = this.height * HIT_ZONE_Y_RATIO;
    const sheetBottom = Math.max(this.sheetBottom, 0);

    for (const [lane, beam] of this._grindBeams) {
      if (currentTime >= beam.endTime) {
        this._grindBeams.delete(lane);
        continue;
      }
      const noteName = NOTE_NAMES[lane];
      const layout = getPianoKeyLayout(noteName ?? 'C4', this.width, visibleRange);
      if (layout.width === 0) continue;
      const beamEndY = Math.max(
        sheetBottom,
        hitZoneY - (beam.endTime - currentTime) * GRIND_BEAM_SCROLL_PX_PER_SEC,
      );
      const ramp = Math.min(1, (this._now - beam.startMs) / GRIND_BEAM_RAMP_MS);
      this._drawGrindBeam(
        ctx,
        layout.x + layout.width / 2,
        hitZoneY,
        beamEndY,
        layout.width * 0.9,
        beam.rgb,
        ramp,
      );
    }

    for (let i = this._grindFlashes.length - 1; i >= 0; i--) {
      const f = this._grindFlashes[i];
      const elapsed = this._now - f.startMs;
      if (elapsed >= GRIND_FLASH_MS) {
        this._grindFlashes.splice(i, 1);
        continue;
      }
      const noteName = NOTE_NAMES[f.lane];
      const layout = getPianoKeyLayout(noteName ?? 'C4', this.width, visibleRange);
      if (layout.width === 0) continue;
      this._drawGrindFlash(
        ctx,
        layout.x + layout.width / 2,
        hitZoneY,
        f.rgb,
        elapsed,
        layout.width * 0.9,
      );
    }
  }

  private _jitterX(
    cx: number,
    halfW: number,
    sFreq: number,
    cFreq: number,
    i: number,
    phase: number,
  ): number {
    const jitter = halfW * 2 * GRIND_JAGGER;
    const j = jitter * (Math.sin(sFreq + i * 1.7 + phase) + Math.cos(cFreq + i * 2.3 + phase));
    return cx + Math.max(-halfW + 2, Math.min(halfW - 2, j));
  }

  private _drawGrindBeam(
    ctx: CanvasRenderingContext2D,
    cx: number,
    hitZoneY: number,
    beamTop: number,
    laneW: number,
    rgb: RGB,
    ramp: number,
  ): void {
    const t = this._now / 1000;
    const pulse = 0.7 + 0.3 * Math.sin(t * 12);
    const beamH = hitZoneY - beamTop;
    if (beamH <= 0) return;
    const intensity = Math.max(0, ramp);

    const colW = laneW;
    const glow = ctx.createLinearGradient(0, beamTop, 0, hitZoneY);
    glow.addColorStop(0, this._rgba(rgb, 0));
    glow.addColorStop(0.5, this._rgba(rgb, 0.12 * pulse * intensity));
    glow.addColorStop(1, this._rgba(rgb, 0.32 * pulse * intensity));
    ctx.fillStyle = glow;
    ctx.fillRect(cx - colW / 2, beamTop, colW, beamH);

    const halfW = laneW * 0.5;
    ctx.save();
    ctx.globalAlpha = intensity;
    ctx.strokeStyle = GRIND_HIGHLIGHT_COLOR;
    ctx.lineWidth = Math.max(2, laneW * 0.1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (!isLowEndDevice()) {
      ctx.shadowColor = this._rgba(rgb, 1);
      ctx.shadowBlur = 14 * pulse;
    }
    ctx.beginPath();
    const segs = Math.max(6, Math.floor(GRIND_BEAM_SEGMENTS * (beamH / LANE_GLOW_HEIGHT)));
    ctx.moveTo(cx, hitZoneY);
    for (let i = 1; i <= segs; i++) {
      const py = hitZoneY - (beamH * i) / segs;
      const px = this._jitterX(cx, halfW, t * 40, t * 31, i, 0);
      ctx.lineTo(px, py);
    }
    ctx.stroke();

    ctx.strokeStyle = this._rgba(rgb, 0.85 * pulse);
    ctx.lineWidth = Math.max(1, laneW * 0.05);
    if (!isLowEndDevice()) ctx.shadowBlur = 22 * pulse;
    ctx.beginPath();
    ctx.moveTo(cx, hitZoneY);
    for (let i = 1; i <= segs; i++) {
      const py = hitZoneY - (beamH * i) / segs;
      const px = this._jitterX(cx, halfW, t * 40, t * 31, i, 0.5);
      ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    const burstR = laneW * 0.9 * pulse * intensity;
    if (burstR > 1) {
      const bgrad = ctx.createRadialGradient(cx, hitZoneY, 0, cx, hitZoneY, burstR);
      bgrad.addColorStop(0, this._rgba(rgb, 0.7 * pulse * intensity));
      bgrad.addColorStop(0.5, this._rgba(rgb, 0.25 * pulse * intensity));
      bgrad.addColorStop(1, this._rgba(rgb, 0));
      ctx.fillStyle = bgrad;
      ctx.fillRect(cx - burstR, hitZoneY - burstR, burstR * 2, burstR * 2);
    }
  }

  private _drawGrindFlash(
    ctx: CanvasRenderingContext2D,
    cx: number,
    hitZoneY: number,
    rgb: RGB,
    elapsed: number,
    laneW: number,
  ): void {
    const p = elapsed / GRIND_FLASH_MS;
    const alpha = 1 - p;
    const streakH = p * GRIND_FLASH_HEIGHT;
    const colW = laneW;

    const grad = ctx.createLinearGradient(0, hitZoneY - streakH, 0, hitZoneY);
    grad.addColorStop(0, this._rgba(rgb, 0));
    grad.addColorStop(1, this._rgba(rgb, 0.55 * alpha));
    ctx.fillStyle = grad;
    ctx.fillRect(cx - colW / 2, hitZoneY - streakH, colW, streakH);

    const halfW = laneW * 0.5;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = GRIND_HIGHLIGHT_COLOR;
    ctx.lineWidth = Math.max(2, laneW * 0.1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (!isLowEndDevice()) {
      ctx.shadowColor = this._rgba(rgb, 1);
      ctx.shadowBlur = 16;
    }
    ctx.beginPath();
    ctx.moveTo(cx, hitZoneY);
    const segs = GRIND_FLASH_SEGMENTS;
    for (let i = 1; i <= segs; i++) {
      const py = hitZoneY - (streakH * i) / segs;
      const px = this._jitterX(cx, halfW, this._now / 60, this._now / 53, i, 0);
      ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    const burstR = laneW * 0.8 * (0.6 + 0.4 * alpha);
    const bgrad = ctx.createRadialGradient(cx, hitZoneY, 0, cx, hitZoneY, burstR);
    bgrad.addColorStop(0, this._rgba(rgb, 0.8 * alpha));
    bgrad.addColorStop(0.5, this._rgba(rgb, 0.3 * alpha));
    bgrad.addColorStop(1, this._rgba(rgb, 0));
    ctx.fillStyle = bgrad;
    ctx.fillRect(cx - burstR, hitZoneY - burstR, burstR * 2, burstR * 2);

    if (isLowEndDevice()) return;

    for (let i = 0; i < GRIND_FLASH_SPARKS; i++) {
      const a = (i / GRIND_FLASH_SPARKS) * Math.PI * 2 + this._now / 200;
      const r = burstR * (0.4 + 0.6 * alpha) * (0.5 + 0.5 * Math.sin(i * 1.7 + this._now / 90));
      const sx = cx + Math.cos(a) * r;
      const sy = hitZoneY - Math.abs(Math.sin(a)) * streakH * 0.3;
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = i % 2 === 0 ? GRIND_HIGHLIGHT_COLOR : this._rgba(rgb, 1);
      ctx.beginPath();
      ctx.arc(sx, sy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private _findFirstIndex(notes: SongNote[], time: number): number {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (notes[mid].time < time) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Time-sorted note closest to `t` across two sorted staff arrays.
   *  Binary search instead of a linear scan: the loop overlay calls this
   *  for every visible marker on every frame. */
  private _nearestNoteAtTime(
    t: number,
    trebleNotes: SongNote[],
    bassNotes: SongNote[],
  ): SongNote | null {
    let best: SongNote | null = null;
    let bestDiff = Infinity;
    for (const list of [trebleNotes, bassNotes]) {
      const idx = this._findFirstIndex(list, t);
      for (const n of [list[idx - 1], list[idx]]) {
        if (!n) continue;
        const d = Math.abs(n.time - t);
        if (d < bestDiff) {
          bestDiff = d;
          best = n;
        }
      }
    }
    return best;
  }

  private _renderStaffCache(
    sheetTop: number,
    trebleTop: number,
    bassTop: number,
    staffLineSpacing: number,
    _clefW: number,
    margin: number,
    sheetBottom: number,
    sheetScale: number,
  ): void {
    const c = themeManager.canvas;
    const w = this.canvas.width;
    const h = sheetBottom;
    this._staffCache = document.createElement('canvas');
    this._staffCache.width = w;
    this._staffCache.height = h;
    const ctx = this._staffCache.getContext('2d')!;

    ctx.fillStyle = c.bg;
    ctx.fillRect(0, sheetTop, w, sheetBottom);

    ctx.strokeStyle = c.staffLine;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(margin, trebleTop + i * staffLineSpacing);
      ctx.lineTo(w - margin, trebleTop + i * staffLineSpacing);
      ctx.stroke();
    }
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(margin, bassTop + i * staffLineSpacing);
      ctx.lineTo(w - margin, bassTop + i * staffLineSpacing);
      ctx.stroke();
    }

    ctx.fillStyle = c.clef;
    ctx.font = `bold ${staffLineSpacing * 5}px serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('\uD834\uDD1E', margin + 2, trebleTop + 2 * staffLineSpacing);
    ctx.fillText('\uD834\uDD22', margin + 2, bassTop + 2 * staffLineSpacing);

    this._cachedStaffScale = sheetScale;
    this._cachedStaffWidth = this.width;
    this._cachedStaffTop = sheetTop;
    this._cachedStaffBottom = sheetBottom;
  }

  drawSheetMusic(
    trebleNotes: SongNote[],
    bassNotes: SongNote[],
    currentTime: number,
    songDuration: number,
    loop?: {
      chain: ReadonlyArray<{ startTime: number; endTime: number }>;
      currentIndex: number | null;
      draftStart: number | null;
      draftEnd: number | null;
      defining: LoopDefinitionState;
    },
    viewWindow?: { start: number; end: number },
    bpm = 120,
    selectedLoop?: { startTime: number; endTime: number },
  ): void {
    if ((!trebleNotes.length && !bassNotes.length) || songDuration <= 0) return;
    const ctx = this.ctx;
    const sheetTop = SHEET_TOP_OFFSET;
    const availableHeight = this._standardNotationBottom() - sheetTop;
    const standardScale = Math.min(
      STANDARD_NOTATION_MAX_SCALE,
      Math.max(0.5, availableHeight / SHEET_BASE_HEIGHT),
    );
    const sheetScale = this.standardNotation ? standardScale : this.sheetScale;
    const staffLineSpacing = SHEET_STAFF_LINE_SPACING * sheetScale;
    const staffH = 4 * staffLineSpacing;
    const clefW = CLEF_WIDTH * sheetScale;
    const margin = SHEET_MARGIN * sheetScale;

    const renderedHeight = SHEET_BASE_HEIGHT * sheetScale;
    const verticalOffset = this.standardNotation ? Math.max(0, (availableHeight - renderedHeight) / 2) : 0;
    const trebleTop = sheetTop + verticalOffset + STAFF_TOP_PADDING * sheetScale;
    const bassTop = trebleTop + staffH + STAFF_GAP * sheetScale;
    const sheetBottom = bassTop + staffH + STAFF_BOTTOM_PADDING * sheetScale;
    this.sheetBottom = sheetBottom;
    this.sheetTrebleTop = trebleTop;
    this.sheetTrebleBottom = trebleTop + staffH;
    this.sheetBassTop = bassTop;
    this.sheetBassBottom = bassTop + staffH;
    this._activeSheetScale = sheetScale;

    if (
      !this._staffCache ||
      this._cachedStaffScale !== sheetScale ||
      this._cachedStaffWidth !== this.width ||
      this._cachedStaffTop !== sheetTop ||
      this._cachedStaffBottom !== sheetBottom
    ) {
      this._renderStaffCache(
        sheetTop,
        trebleTop,
        bassTop,
        staffLineSpacing,
        clefW,
        margin,
        sheetBottom,
        sheetScale,
      );
    }
    ctx.drawImage(this._staffCache!, 0, 0);

    const barX = margin + clefW;
    const barW = this.width - barX - margin;
    const viewStart = viewWindow ? viewWindow.start : currentTime - 0.5;
    const beatsVisible = this.standardNotation ? STANDARD_NOTATION_BEATS_VISIBLE : SHEET_BEATS_VISIBLE;
    const viewEnd = viewWindow ? viewWindow.end : currentTime + beatsVisible * (60 / bpm);
    this.sheetBarX = barX;
    this.sheetBarW = barW;
    this.sheetViewStart = viewStart;
    this.sheetViewEnd = viewEnd;

    const L: SheetLayout = {
      ctx,
      sheetTop,
      sheetBottom,
      barX,
      barW,
      viewStart,
      viewEnd,
      staffLineSpacing,
      scale: sheetScale,
      beatsPerSecond: bpm / 60,
    };

    this._drawBeatLines(L, bpm);
    this._drawSheetNotes(trebleNotes, trebleTop, L);
    this._drawSheetNotes(bassNotes, bassTop, L);
    this._drawPlaybackCursor(L, currentTime, viewWindow);
    this._drawLoopRegion(L, loop, trebleNotes, bassNotes, selectedLoop);

    ctx.strokeStyle = themeManager.canvas.sheetBorder;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, sheetBottom);
    ctx.lineTo(this.width, sheetBottom);
    ctx.stroke();
  }

  private _drawBeatLines(L: SheetLayout, bpm: number): void {
    const { ctx, sheetTop, sheetBottom, barX, barW, viewStart, viewEnd } = L;
    const c = themeManager.canvas;
    const firstBeat = Math.ceil(viewStart / (60 / bpm));
    const lastBeat = Math.floor(viewEnd / (60 / bpm));

    ctx.strokeStyle = c.measureLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let beat = firstBeat; beat <= lastBeat; beat++) {
      if (beat % SHEET_BEATS_PER_MEASURE !== 0) continue;
      const beatTime = beat * (60 / bpm);
      const x = barX + ((beatTime - viewStart) / (viewEnd - viewStart)) * barW;
      ctx.moveTo(x, sheetTop);
      ctx.lineTo(x, sheetBottom);
    }
    ctx.stroke();

    ctx.strokeStyle = c.beatLine;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let beat = firstBeat; beat <= lastBeat; beat++) {
      if (beat % SHEET_BEATS_PER_MEASURE === 0) continue;
      const beatTime = beat * (60 / bpm);
      const x = barX + ((beatTime - viewStart) / (viewEnd - viewStart)) * barW;
      ctx.moveTo(x, sheetTop);
      ctx.lineTo(x, sheetBottom);
    }
    ctx.stroke();
  }

  private _sheetDuration(duration: number, beatsPerSecond: number): {
    beats: number;
    flags: number;
    hollow: boolean;
    dotted: boolean;
    whole: boolean;
  } {
    const beats = duration * beatsPerSecond;
    const values = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25, 0.125];
    const nearest = values.reduce((best, value) =>
      Math.abs(beats - value) < Math.abs(beats - best) ? value : best,
    );

    return {
      beats: nearest,
      flags: nearest >= 1 ? 0 : nearest >= 0.5 ? 1 : nearest >= 0.25 ? 2 : 3,
      hollow: nearest >= 2,
      dotted: nearest === 3 || nearest === 1.5 || nearest === 0.75,
      whole: nearest >= 4,
    };
  }

  private _drawLedgerLines(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    staffTop: number,
    spacing: number,
    color: string,
  ): void {
    const top = staffTop;
    const bottom = staffTop + spacing * 4;
    const width = spacing * 1.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, spacing / 10);

    for (let lineY = top - spacing; y <= lineY; lineY -= spacing) {
      ctx.beginPath();
      ctx.moveTo(x - width, lineY);
      ctx.lineTo(x + width, lineY);
      ctx.stroke();
    }

    for (let lineY = bottom + spacing; y >= lineY; lineY += spacing) {
      ctx.beginPath();
      ctx.moveTo(x - width, lineY);
      ctx.lineTo(x + width, lineY);
      ctx.stroke();
    }
  }

  private _drawSheetFlag(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    stemDir: number,
    scale: number,
    index: number,
  ): void {
    const offset = index * 5 * scale;
    ctx.beginPath();
    ctx.moveTo(x, y + offset * stemDir);
    ctx.bezierCurveTo(
      x + 5 * scale,
      y + (offset + 1 * scale) * stemDir,
      x + 9 * scale,
      y + (offset + 5 * scale) * stemDir,
      x + 3 * scale,
      y + (offset + 10 * scale) * stemDir,
    );
    ctx.stroke();
  }

  private _drawSheetNote(note: SongNote, staffTop: number, L: SheetLayout): void {
    const c = themeManager.canvas;
    const { ctx, barX, barW, viewStart, viewEnd, staffLineSpacing, scale } = L;
    const pos = SHEET_NOTE_POSITIONS[note.key];
    if (pos === undefined) return;
    const noteY = staffTop + (8 - pos) * (staffLineSpacing / 2);

    const x = barX + ((note.time - viewStart) / (viewEnd - viewStart)) * barW;
    const r = SHEET_NOTE_RADIUS * scale;
    const duration = this._sheetDuration(note.duration, L.beatsPerSecond);
    const color = note.hit ? c.hitNote : note.selected ? handColor(note.key) : c.backingNote;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    this._drawLedgerLines(ctx, x, noteY, staffTop, staffLineSpacing, color);

    ctx.save();
    ctx.translate(x, noteY);
    ctx.rotate(-0.32);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.15, r * 0.68, 0, 0, Math.PI * 2);

    if (duration.hollow || duration.whole) {
      ctx.lineWidth = Math.max(1.5, scale);
      ctx.stroke();
    } else {
      ctx.fill();
    }
    ctx.restore();

    if (note.key.includes('#')) {
      ctx.font = `${staffLineSpacing * 1.5}px ${themeManager.fonts.mono}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('#', x - r * 1.7, noteY);
    }

    if (!duration.whole) {
      const stemUp = pos <= 3;
      const stemDir = stemUp ? -1 : 1;
      const stemX = stemUp ? x + r * 0.95 : x - r * 0.95;
      const stemEndY = noteY + stemDir * staffLineSpacing * 2.5;
      ctx.lineWidth = Math.max(1, scale);
      ctx.beginPath();
      ctx.moveTo(stemX, noteY);
      ctx.lineTo(stemX, stemEndY);
      ctx.stroke();

      for (let i = 0; i < duration.flags; i++) {
        this._drawSheetFlag(ctx, stemX, stemEndY, stemDir, scale, i);
      }
    }

    if (duration.dotted) {
      ctx.beginPath();
      ctx.arc(x + r * 2.1, noteY - staffLineSpacing * 0.45, Math.max(1.5, scale * 1.2), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private _drawSheetNotes(notes: SongNote[], staffTop: number, L: SheetLayout): void {
    const start = this._findFirstIndex(notes, L.viewStart);
    for (let i = start; i < notes.length; i++) {
      const note = notes[i];
      if (note.time > L.viewEnd) break;
      this._drawSheetNote(note, staffTop, L);
    }
  }

  private _drawPlaybackCursor(
    L: SheetLayout,
    currentTime: number,
    viewWindow?: { start: number; end: number },
  ): void {
    const { ctx, barX, barW, viewStart, viewEnd, sheetTop, sheetBottom } = L;
    const cursorColor = themeManager.canvas.playbackCursor;
    const showCursor = viewWindow ? currentTime >= viewStart && currentTime <= viewEnd : true;
    if (!showCursor) return;
    const cursorX = barX + ((currentTime - viewStart) / (viewEnd - viewStart)) * barW;
    ctx.fillStyle = cursorColor;
    if (viewWindow) {
      ctx.globalAlpha = 0.25;
      ctx.fillRect(cursorX - 4, sheetTop, 8, sheetBottom - sheetTop);
      ctx.globalAlpha = 1;
      ctx.fillRect(cursorX - 1, sheetTop, 2, sheetBottom - sheetTop);
    } else {
      const standard = this.standardNotation;
      ctx.globalAlpha = standard ? 0.18 : 0.25;
      ctx.fillRect(cursorX - (standard ? 10 : 3), sheetTop, standard ? 20 : 6, sheetBottom - sheetTop);
      ctx.globalAlpha = 1;

      if (standard) {
        ctx.save();
        ctx.shadowColor = cursorColor;
        ctx.shadowBlur = isLowEndDevice() ? 0 : 18;
        ctx.fillRect(cursorX - 1.5, sheetTop, 3, sheetBottom - sheetTop);
        ctx.shadowBlur = 0;
        ctx.fillRect(cursorX - 7, sheetTop, 14, 3);
        ctx.fillRect(cursorX - 7, sheetBottom - 3, 14, 3);
        ctx.font = `bold 12px ${themeManager.fonts.mono}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('HIT', cursorX, sheetTop - 8);
        ctx.restore();
      } else {
        ctx.fillRect(cursorX - 0.5, sheetTop, 1.5, sheetBottom - sheetTop);
      }
    }
  }

  private _drawLoopRegion(
    L: SheetLayout,
    loop:
      | {
          chain: ReadonlyArray<{ startTime: number; endTime: number }>;
          currentIndex: number | null;
          draftStart: number | null;
          draftEnd: number | null;
          defining: LoopDefinitionState;
        }
      | undefined,
    trebleNotes: SongNote[],
    bassNotes: SongNote[],
    selectedLoop?: { startTime: number; endTime: number },
  ): void {
    const c = themeManager.canvas;
    const { ctx, barX, barW, viewStart, viewEnd, sheetTop, sheetBottom } = L;
    if (!loop) return;

    const drawMarker = (t: number, color: string, label: string): void => {
      if (t < viewStart || t > viewEnd) return;
      const lx = barX + ((t - viewStart) / (viewEnd - viewStart)) * barW;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.2;
      ctx.fillRect(lx - 3, sheetTop, 6, sheetBottom - sheetTop);
      ctx.globalAlpha = 1;
      ctx.fillRect(lx - 1, sheetTop, 2, sheetBottom - sheetTop);
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, lx, sheetTop - 10);
    };

    const highlightAt = (t: number, color: string, alpha: number): void => {
      if (t < viewStart || t > viewEnd) return;
      const best = this._nearestNoteAtTime(t, trebleNotes, bassNotes);
      if (!best) return;
      const pixelPos = this.notePixelPosition(best);
      if (!pixelPos) return;
      const r = (SHEET_NOTE_RADIUS + 5) * L.scale;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(pixelPos.x, pixelPos.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5 * L.scale;
      ctx.stroke();
      ctx.restore();
    };

    const drawRegion = (start: number, end: number, fill: string): void => {
      const lx0 = barX + ((Math.max(start, viewStart) - viewStart) / (viewEnd - viewStart)) * barW;
      const lx1 = barX + ((Math.min(end, viewEnd) - viewStart) / (viewEnd - viewStart)) * barW;
      if (lx1 <= lx0) return;
      ctx.save();
      ctx.fillStyle = fill;
      ctx.fillRect(lx0, sheetTop, lx1 - lx0, sheetBottom - sheetTop);
      ctx.restore();
    };

    // Saved enabled loops: inactive loops get the inactive overlay, the
    // current (playing) one gets the active overlay. Draw inactive ones
    // first so the active overlay sits on top.
    const chain = loop.chain;
    const currentIndex = loop.currentIndex;
    for (let i = 0; i < chain.length; i++) {
      if (i === currentIndex) continue;
      drawRegion(chain[i].startTime, chain[i].endTime, c.loopOverlayInactive);
      drawMarker(chain[i].startTime, c.loopMarker, 'A');
      drawMarker(chain[i].endTime, c.loopMarker, 'B');
    }
    if (currentIndex !== null && currentIndex >= 0 && currentIndex < chain.length) {
      const cur = chain[currentIndex];
      drawRegion(cur.startTime, cur.endTime, c.loopOverlayActive);
      drawMarker(cur.startTime, c.loopMarker, 'A');
      drawMarker(cur.endTime, c.loopMarker, 'B');
      highlightAt(cur.startTime, c.loopMarker, 0.7);
      highlightAt(cur.endTime, c.loopMarker, 0.7);
    }

    // Draft (define-flow) overlay on top of everything.
    const draftStart = loop.draftStart;
    const draftDefining = loop.defining;
    if (draftDefining === LoopDefinitionState.End && draftStart !== null) {
      drawMarker(draftStart, c.loopMarker, 'A');
      highlightAt(draftStart, c.loopMarker, 0.9);
      // Preview fills from the start marker to the right edge of the view.
      drawRegion(draftStart, viewEnd, c.loopDefiningPreview);
    } else if (draftDefining === LoopDefinitionState.Start && draftStart !== null) {
      drawMarker(draftStart, c.loopMarker, 'A');
    }

    if (selectedLoop) {
      this._drawSelectedLoopNotes(L, c.noteHighlight, trebleNotes, bassNotes, selectedLoop);
    }
  }

  private _drawSelectedLoopNotes(
    L: SheetLayout,
    color: string,
    trebleNotes: SongNote[],
    bassNotes: SongNote[],
    selectedLoop: { startTime: number; endTime: number },
  ): void {
    const { ctx, barX, barW, viewStart, viewEnd, staffLineSpacing } = L;

    const notePosition = (n: SongNote): { x: number; y: number } | null => {
      const pos = SHEET_NOTE_POSITIONS[n.key];
      if (pos === undefined) return null;
      const staffTop = n.hand === HandSide.Left ? this.sheetBassTop : this.sheetTrebleTop;
      const x = barX + ((n.time - viewStart) / (viewEnd - viewStart)) * barW;
    const y = staffTop + (8 - pos) * (staffLineSpacing / 2);

      return { x, y };
    };

    const highlightNote = (n: SongNote): void => {
      if (n.time < viewStart || n.time > viewEnd) return;
      if (n.time < selectedLoop.startTime || n.time > selectedLoop.endTime) return;
      const p = notePosition(n);
      if (!p) return;
      const r = (SHEET_NOTE_RADIUS + 5) * L.scale;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * L.scale;
      ctx.stroke();
      ctx.restore();
    };

    for (const list of [trebleNotes, bassNotes]) {
      const startIdx = this._findFirstIndex(list, selectedLoop.startTime);
      for (let i = startIdx; i < list.length; i++) {
        const n = list[i];
        if (n.time > selectedLoop.endTime) break;
        highlightNote(n);
      }
    }
  }

  drawParticles(): void {
    const ctx = this.ctx;
    const particles = this.particles;
    let i = 0;
    while (i < particles.length) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15;
      p.life -= 0.025;

      if (p.life <= 0) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
        continue;
      }

      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
      i++;
    }
    ctx.globalAlpha = 1;
  }

  spawnParticles(x: number, y: number, color: string, count: number): void {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 8,
        vy: (Math.random() - 0.5) * 8 - 3,
        size: 2 + Math.random() * 3,
        color,
        life: 1,
      });
    }
  }
}
