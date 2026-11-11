import { type Game, GameState } from '../../game/Game.js';
import { PracticeHand } from '../../utils/notes.js';
import { fetchUserSettings, updateUserSettings } from '../../api/UserApi.js';
import { themeManager } from '../../themes/ThemeManager.js';
import { formatTime } from '../../utils/helpers.js';
import { setLowEndDeviceMode } from '../../utils/device.js';
import { BTN_DEFINE_LOOP_ID, BTN_LOOP_PLAY_ID, LOOP_STATUS_ID } from '../sheet/sheetElementIds.js';

export class GameControls {
  game: Game;

  constructor(game: Game) {
    this.game = game;

    const modePlay = document.getElementById('mode-play')!;
    const modeLearn = document.getElementById('mode-learn')!;
    const handLeft = document.getElementById('hand-left')!;
    const handRight = document.getElementById('hand-right')!;
    const loopPlayBtn = document.getElementById(BTN_LOOP_PLAY_ID)!;
    const pauseBtn = document.getElementById('btn-pause')!;

    modePlay.addEventListener('click', () => this.setMode(false));
    modeLearn.addEventListener('click', () => this.setMode(true));
    loopPlayBtn.addEventListener('click', () => {
      this.game.loopPlay = !this.game.loopPlay;
      this.updateLoopUI();
    });
    handLeft.addEventListener('click', () =>
      this.setPracticeHand(
        this.game.practiceHand === PracticeHand.Left ? PracticeHand.Both : PracticeHand.Left,
      ),
    );
    handRight.addEventListener('click', () =>
      this.setPracticeHand(
        this.game.practiceHand === PracticeHand.Right ? PracticeHand.Both : PracticeHand.Right,
      ),
    );
    pauseBtn.addEventListener('click', () => {
      if (this.game.state === GameState.Playing) {
        this.game.togglePause();
        this.updatePauseBtn();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (this.game.state !== GameState.Playing) return;

      if (e.code === 'Space') {
        e.preventDefault();
        this.game.togglePause();
        this.updatePauseBtn();
      } else if (e.code === 'KeyN') this.game.seekToNextNote();
    });

    document.getElementById('btn-next-note')!.addEventListener('click', () => {
      if (this.game.state === GameState.Playing) this.game.seekToNextNote();
    });

    // Settings popup
    const settingsPopup = document.getElementById('settings-popup')!;
    const btnSettings = document.getElementById('btn-settings');
    if (btnSettings) {
      btnSettings.addEventListener('click', () => settingsPopup.classList.remove('hidden'));
    }
    document
      .getElementById('btn-close-settings')!
      .addEventListener('click', () => settingsPopup.classList.add('hidden'));
    settingsPopup.addEventListener('click', (e) => {
      if (e.target === settingsPopup) settingsPopup.classList.add('hidden');
    });

    // Theme dropdown
    const btnTheme = document.getElementById('btn-theme');
    const themeDropdown = document.getElementById('theme-dropdown');

    if (btnTheme && themeDropdown) {
      const renderThemeDropdown = () => {
        themeDropdown.innerHTML = '';

        for (const theme of themeManager.availableThemes) {
          const option = document.createElement('button');
          option.className = `theme-option${theme.id === themeManager.current.id ? ' active' : ''}`;
          option.textContent = theme.name;
          option.addEventListener('click', () => {
            themeManager.apply(theme);
            renderThemeDropdown();
            themeDropdown.classList.add('hidden');
          });
          themeDropdown.appendChild(option);
        }
      };

      renderThemeDropdown();

      btnTheme.addEventListener('click', (e) => {
        e.stopPropagation();
        themeDropdown.classList.toggle('hidden');
      });

      document.addEventListener('click', () => {
        themeDropdown.classList.add('hidden');
      });
    }

    // User settings
    this._initUserSettings();
  }

  private async _initUserSettings(): Promise<void> {
    const showUsedKeysCheckbox = document.getElementById('show-used-keys') as HTMLInputElement;
    const octaveAgnosticCheckbox = document.getElementById('octave-agnostic') as HTMLInputElement;
    const lowEndModeCheckbox = document.getElementById('low-end-device-mode') as HTMLInputElement;

    try {
      const settings = await fetchUserSettings();
      this.game.showUsedKeys = settings.piano_show_used_keys_only ?? true;
      showUsedKeysCheckbox.checked = this.game.showUsedKeys;
      this.game.octaveAgnostic = settings.octave_agnostic ?? false;
      octaveAgnosticCheckbox.checked = this.game.octaveAgnostic;
      const lowEndMode = settings.low_end_device_mode ?? false;
      setLowEndDeviceMode(lowEndMode);
      lowEndModeCheckbox.checked = lowEndMode;
    } catch {
      // Keep the checkbox in sync with the client-side default when the
      // settings can't be fetched (e.g. a guest session).
      showUsedKeysCheckbox.checked = this.game.showUsedKeys;
    }

    showUsedKeysCheckbox.addEventListener('change', () => {
      this.game.setShowUsedKeys(showUsedKeysCheckbox.checked);
      updateUserSettings({ piano_show_used_keys_only: showUsedKeysCheckbox.checked }).catch((e) =>
        console.warn('Failed to save settings:', e),
      );
    });

    octaveAgnosticCheckbox.addEventListener('change', () => {
      this.game.octaveAgnostic = octaveAgnosticCheckbox.checked;
      updateUserSettings({ octave_agnostic: octaveAgnosticCheckbox.checked }).catch((e) =>
        console.warn('Failed to save settings:', e),
      );
    });

    lowEndModeCheckbox.addEventListener('change', () => {
      setLowEndDeviceMode(lowEndModeCheckbox.checked);
      updateUserSettings({ low_end_device_mode: lowEndModeCheckbox.checked }).catch((e) =>
        console.warn('Failed to save settings:', e),
      );
    });
  }

  /** Switch LEARN/PLAY mode. `persist = false` skips storing it as the
   *  song's resume mode (used when applying the initial mode at song start,
   *  before the song is the game's current one). */
  setMode(learning: boolean, persist = true): void {
    this.game.setLearningMode(learning, persist);
    const modePlay = document.getElementById('mode-play')!;
    const modeLearn = document.getElementById('mode-learn')!;
    const handControl = document.getElementById('hand-control')!;
    modePlay.classList.toggle('active', !learning);
    modeLearn.classList.toggle('active', learning);
    handControl.classList.toggle('active', learning);

    const accuracyCell = document.getElementById('accuracy-cell')!;
    accuracyCell.style.display = learning ? 'none' : '';

    if (!learning && this.game.loopActive) {
      this.game.deactivateLoop();
      this.updateLoopUI();
    }
  }

  setPracticeHand(hand: PracticeHand): void {
    this.game.setPracticeHand(hand);
    this.applyPracticeHandButtons();
  }

  applyPracticeHandButtons(): void {
    const handLeft = document.getElementById('hand-left')!;
    const handRight = document.getElementById('hand-right')!;
    handLeft.classList.toggle('active', this.game.practiceHand === PracticeHand.Left);
    handRight.classList.toggle('active', this.game.practiceHand === PracticeHand.Right);
  }

  updateLoopUI(): void {
    const defineLoopBtn = document.getElementById(BTN_DEFINE_LOOP_ID)!;
    const loopStatus = document.getElementById(LOOP_STATUS_ID)!;
    const loopPlayBtn = document.getElementById(BTN_LOOP_PLAY_ID)!;
    const phase = this.game.loopDefinitionState;
    defineLoopBtn.classList.toggle('active', phase !== 'off');
    defineLoopBtn.classList.toggle('loop-active', this.game.loopActive);

    const enabledCount = this.game.loop.chain.length;
    const savedCount = this.game.loop.loops.length;
    loopPlayBtn.style.display = this.game.loopActive && this.game.learningMode ? '' : 'none';
    loopPlayBtn.classList.toggle('play-active', this.game.loopPlay);
    loopPlayBtn.textContent = this.game.loopPlay ? '\u23F8' : '\u25B6';

    if (phase === 'start') loopStatus.textContent = 'Click start note';
    else if (phase === 'end') loopStatus.textContent = 'Click end note';
    else if (this.game.loop.hasDraft) loopStatus.textContent = 'Draft ready — Save in Loops panel';
    else if (this.game.loopActive) {
      const cur = this.game.loop.current;
      const chainLen = this.game.loop.chain.length;

      if (cur) {
        // Chain position leads so progress through the loop set stays
        // readable.
        const pos = chainLen > 1 ? `${(this.game.loop.currentIndex ?? 0) + 1}/${chainLen}·` : '';
        const bounds = `${formatTime(cur.startTime)}-${formatTime(cur.endTime)}`;
        loopStatus.textContent = cur.name
          ? `${pos}${cur.name} (${bounds})`
          : `${pos}Loop ${bounds}`;
      } else loopStatus.textContent = 'Chain active';
    } else if (savedCount > 0) {
      loopStatus.textContent =
        enabledCount > 0
          ? `${enabledCount} of ${savedCount} loops enabled`
          : `${savedCount} loop${savedCount === 1 ? '' : 's'} saved`;
    } else loopStatus.textContent = 'No loops';
  }

  updatePauseBtn(): void {
    const pauseBtn = document.getElementById('btn-pause')!;
    pauseBtn.innerHTML = this.game.paused ? '&#9654;' : '&#9646;&#9646;';
    pauseBtn.title = this.game.paused ? 'Resume (Space)' : 'Pause (Space)';
  }
}
