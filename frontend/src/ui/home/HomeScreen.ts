import { themeManager } from '../../themes/ThemeManager.js';
import type { ThemeCss } from '../../themes/types.js';
import type { AppMode } from '../../main.js';
import { LeaderboardPanel } from './LeaderboardPanel.js';
import { type NavAction, runNavAction, setFocused } from '../navFocus.js';
import { renderMidiStatus } from '../midiStatus.js';

const KEY_TO_NAV_ACTION: Record<string, NavAction> = {
  ArrowUp: 'prev',
  ArrowDown: 'next',
  Enter: 'enter',
};

interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  life: number;
  maxLife: number;
  type: 'ember' | 'spark';
}

interface Flash {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  life: number;
}

const MAX_EMBERS = 50;
const SPARK_INTERVAL = 0.15;
/** Fraction of CSS resolution the home canvas renders at; the browser
 *  upscales with image-rendering: pixelated for the retro pixel look. */
const PIXEL_RENDER_SCALE = 0.5;

const SPARK_ALT_COLOR = '#ff7722';
const FLASH_MID_COLOR = '#ff4400';
const EMBER_COLORS: readonly string[] = ['#ff4400', '#ff6622'];
const EMBER_CORE_COLOR = '#ffaa00';
const SPARK_CORE_COLOR = '#ffffff';

export interface HomeScreenOptions {
  onNavigate?: (mode: AppMode) => void;
  onLogout?: () => void;
  onDeleteAccount?: () => void;
}

export class HomeScreen {
  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;
  private _screen: HTMLElement;
  private _embers: Ember[] = [];
  private _flashes: Flash[] = [];
  private _animId: number | null = null;
  private _lastTime: number = 0;
  private _sparkAccum = 0;
  private _cards: HTMLElement[] = [];
  private _midiStatusEl: HTMLElement;
  private _leaderboard: LeaderboardPanel;
  private _opts: HomeScreenOptions;

  constructor(opts: HomeScreenOptions = {}) {
    this._opts = opts;
    this._screen = document.getElementById('home-screen')!;
    this._canvas = document.getElementById('home-canvas') as HTMLCanvasElement;
    this._ctx = this._canvas.getContext('2d')!;
    this._midiStatusEl = document.getElementById('midi-status-home')!;
    this._leaderboard = new LeaderboardPanel();

    this._resize();
    window.addEventListener('resize', () => this._resize());

    this._wireButtons();
    this._wireKeyboardNav();

    this._setupSettingsPopup();
    this._setupThemeSelector();
  }

  show(): void {
    this._screen.classList.add('active');
    this._startAnimation();
    this._leaderboard.refresh();
  }

  hide(): void {
    this._screen.classList.remove('active');
    this._stopAnimation();
  }

  updateMidiStatus(connected: boolean, message: string): void {
    renderMidiStatus(this._midiStatusEl, connected, message);
  }

  /** Re-fetch and re-render the leaderboard panel (e.g. after a scoring run
   *  returns to the home screen). Never rejects. */
  refreshLeaderboard(): void {
    this._leaderboard.refresh();
  }

  /** Drive the main-menu cards with a bound note shortcut: prev moves the
   *  focus up one card, next moves it down, enter acts on the focused card. */
  cardAction(action: NavAction): void {
    runNavAction(this._cards, action);
  }

  // --- internals: wiring -----------------------------------------------------

  private _wireButtons(): void {
    const freeplayBtn = this._screen.querySelector('[data-mode="freeplay"]') as HTMLElement;
    const settingsBtn = this._screen.querySelector('[data-mode="settings"]') as HTMLElement;
    const logoutBtn = this._screen.querySelector('[data-mode="logout"]') as HTMLElement;

    this._cards = [freeplayBtn, settingsBtn, logoutBtn];

    freeplayBtn.addEventListener('click', () => {
      this._opts.onNavigate?.('freeplay');
      this._screen.classList.remove('active');
      document.getElementById('freeplay-screen')!.classList.add('active');
      this._stopAnimation();
    });

    settingsBtn.addEventListener('click', () => {
      this._opts.onNavigate?.('settings');
      document.getElementById('settings-popup')!.classList.remove('hidden');
    });

    logoutBtn.addEventListener('click', () => {
      this._opts.onLogout?.();
    });

    for (const card of this._cards) {
      card.addEventListener('click', () => setFocused(this._cards, card));
    }
  }

  private _wireKeyboardNav(): void {
    document.addEventListener('keydown', (e) => {
      if (!this._screen.classList.contains('active')) return;

      const action = KEY_TO_NAV_ACTION[e.key];

      if (action) {
        e.preventDefault();
        runNavAction(this._cards, action);
      }
    });
  }

  private _resize(): void {
    this._canvas.width = Math.max(1, Math.floor(window.innerWidth * PIXEL_RENDER_SCALE));
    this._canvas.height = Math.max(1, Math.floor(window.innerHeight * PIXEL_RENDER_SCALE));
    this._canvas.style.width = `${window.innerWidth}px`;
    this._canvas.style.height = `${window.innerHeight}px`;
    this._ctx.setTransform(PIXEL_RENDER_SCALE, 0, 0, PIXEL_RENDER_SCALE, 0, 0);
  }

  private _startAnimation(): void {
    if (this._animId !== null) return;

    this._embers = [];
    this._flashes = [];
    this._sparkAccum = 0;
    this._lastTime = 0;

    const loop = (time: number) => {
      if (this._lastTime === 0) this._lastTime = time;
      const dt = Math.min((time - this._lastTime) / 1000, 0.1);
      this._lastTime = time;
      this._tick(dt);
      this._animId = requestAnimationFrame(loop);
    };

    this._animId = requestAnimationFrame(loop);
  }

  private _stopAnimation(): void {
    if (this._animId !== null) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
  }

  // --- internals: animation -------------------------------------------------

  private _tick(dt: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const css = themeManager.current.css;

    this._renderBackground(w, h);
    this._updateFlashes(dt, css);
    this._spawnParticles(dt, w, h, css);
    this._updateEmbers(dt, w, h);
  }

  private _renderBackground(w: number, h: number): void {
    const ctx = this._ctx;
    const vignette = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = themeManager.canvas.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  private _updateFlashes(dt: number, css: ThemeCss): void {
    const ctx = this._ctx;

    for (let i = this._flashes.length - 1; i >= 0; i--) {
      const f = this._flashes[i];
      f.life -= dt;

      if (f.life <= 0) {
        this._flashes.splice(i, 1);
        continue;
      }

      const fade = f.life / 0.3;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.radius * fade);
      g.addColorStop(0, this._alphaHex(css.accentRed, f.alpha * fade));
      g.addColorStop(0.4, this._alphaHex(FLASH_MID_COLOR, f.alpha * fade * 0.3));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(f.x - f.radius, f.y - f.radius, f.radius * 2, f.radius * 2);
    }
  }

  private _spawnParticles(dt: number, w: number, h: number, css: ThemeCss): void {
    this._sparkAccum += dt;

    while (this._sparkAccum >= SPARK_INTERVAL) {
      this._sparkAccum -= SPARK_INTERVAL;
      this._spawnSpark(w, h, css);
    }

    if (Math.random() < dt * 3 && this._embers.length < MAX_EMBERS) {
      this._embers.push(this._createEmber(w, h, css));
    }

    if (Math.random() < dt * 0.6) {
      this._flashes.push({
        x: w * 0.1 + Math.random() * w * 0.8,
        y: h * 0.3 + Math.random() * h * 0.4,
        radius: 60 + Math.random() * 200,
        alpha: 0.03 + Math.random() * 0.08,
        life: 0.2 + Math.random() * 0.4,
      });
    }
  }

  private _updateEmbers(dt: number, w: number, h: number): void {
    const ctx = this._ctx;

    for (let i = this._embers.length - 1; i >= 0; i--) {
      const e = this._embers[i];
      e.life -= dt;

      if (e.life <= 0 || e.y < -50 || e.x < -50 || e.x > w + 50) {
        this._embers.splice(i, 1);
        continue;
      }

      if (e.type === 'ember') {
        e.vy -= dt * 15;
        e.x += Math.sin(e.life * 4 + e.x * 0.01) * dt * 40;
      } else {
        e.vx *= 0.98;
        e.vy += dt * 50;
      }

      e.x += e.vx * dt;
      e.y += e.vy * dt;

      this._drawEmber(ctx, e, h);
    }
  }

  private _spawnSpark(w: number, h: number, css: ThemeCss): void {
    const cx = w * 0.1 + Math.random() * w * 0.8;
    const cy = h * 0.6 + Math.random() * h * 0.3;

    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 200;
      this._embers.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        size: 1.5 + Math.random() * 2.5,
        color: Math.random() > 0.5 ? css.accentRed : SPARK_ALT_COLOR,
        life: 0.3 + Math.random() * 0.7,
        maxLife: 1,
        type: 'spark',
      });
    }
  }

  private _createEmber(w: number, h: number, css: ThemeCss): Ember {
    const colors = [css.accentRed, ...EMBER_COLORS, css.accentOrange];
    return {
      x: Math.random() * w,
      y: h * 0.5 + Math.random() * h * 0.5,
      vx: (Math.random() - 0.5) * 20,
      vy: -20 - Math.random() * 60,
      size: 2 + Math.random() * 8,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 2 + Math.random() * 5,
      maxLife: 7,
      type: 'ember',
    };
  }

  private _drawEmber(ctx: CanvasRenderingContext2D, e: Ember, screenH: number): void {
    const lifeRatio = Math.max(0, e.life / e.maxLife);
    let alpha = lifeRatio;

    // Embers glow brighter near the bottom
    if (e.type === 'ember') {
      alpha = 1 - e.y / (screenH * 0.5);
      alpha = Math.max(0.05, Math.min(0.5, alpha));
    }

    ctx.save();
    ctx.globalAlpha = alpha * 0.6;

    // Glow layer
    const glow = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.size * 3);
    glow.addColorStop(0, e.color);
    glow.addColorStop(0.5, this._alphaHex(e.color, 0.3));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(e.x - e.size * 4, e.y - e.size * 4, e.size * 8, e.size * 8);

    // Core particle (angular shard shape)
    if (e.type === 'ember') {
      ctx.fillStyle = this._alphaHex(EMBER_CORE_COLOR, alpha);
      ctx.beginPath();
      ctx.moveTo(e.x, e.y - e.size);
      ctx.lineTo(e.x + e.size * 0.7, e.y + e.size * 0.5);
      ctx.lineTo(e.x - e.size * 0.7, e.y + e.size * 0.5);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = this._alphaHex(SPARK_CORE_COLOR, alpha * 0.8);
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.size * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private _alphaHex(hex: string, alpha: number): string {
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
      .toString(16)
      .padStart(2, '0');
    return `${hex}${a}`;
  }

  private _setupSettingsPopup(): void {
    const settingsPopup = document.getElementById('settings-popup');
    if (!settingsPopup) return;

    const close = () => {
      settingsPopup.classList.add('hidden');
      this._opts.onNavigate?.('home');
    };

    const btnClose = document.getElementById('btn-close-settings');
    if (btnClose) {
      btnClose.addEventListener('click', () => close());
    }

    const btnDeleteAccount = document.getElementById('btn-delete-account');
    if (btnDeleteAccount) {
      btnDeleteAccount.addEventListener('click', () => this._opts.onDeleteAccount?.());
    }

    settingsPopup.addEventListener('click', (e) => {
      if (e.target === settingsPopup) close();
    });
  }

  private _setupThemeSelector(): void {
    const themeList = document.getElementById('settings-theme-list');
    if (!themeList) return;

    const render = () => {
      themeList.innerHTML = '';

      for (const theme of themeManager.availableThemes) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = `theme-option${theme.id === themeManager.current.id ? ' active' : ''}`;
        option.textContent = theme.name;
        option.addEventListener('click', () => {
          themeManager.apply(theme);
          render();
        });
        themeList.appendChild(option);
      }
    };

    render();
  }
}
