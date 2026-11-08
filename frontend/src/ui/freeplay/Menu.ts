import type { Song } from '../../utils/MidiParser.js';
import { formatScore, formatRelativeTime, reportError } from '../../utils/helpers.js';
import {
  fetchCommunitySongs,
  fetchLibrary,
  fetchLibraryCategorySongs,
  type SongSummary,
} from '../../api/SongApi.js';
import { fetchGuestShowcaseSongs } from '../../api/GuestApi.js';
import { getSongListKeys, matchSongListAction } from './songListKeys.js';
import { RESULTS_SCREEN_ID } from '../../game/rendering/resultsScreenElementIds.js';
import { playMenuSound } from '../../audio/MenuSounds.js';
import { isAdmin } from '../../api/AuthApi.js';
import { FOCUS_CLASS, NAV_ITEM_CLASS, setFocused, stepFocus } from '../navFocus.js';
import { renderMidiStatus } from '../midiStatus.js';

interface GroupedItem {
  song: Song;
  isCommunity: boolean;
}

interface MenuGroup {
  id: number | null;
  name: string;
  items: GroupedItem[];
  total: number;
  loading: boolean;
}

const COLLAPSED_KEY = 'riffernal:collapsed-categories';
const COMMUNITY_PAGE_SIZE = 10;
const CATEGORY_PAGE_SIZE = 10;

export class Menu {
  private _groups: MenuGroup[] = [];
  private _selectedSong: Song | null = null;
  private _communitySongs: Song[] = [];
  private _communityTotal = 0;
  private _communityOffset = 0;
  private _communityLoading = false;
  private _showcaseSongs: Song[] = [];
  private _guestMode = false;
  onStart: ((song: Song) => void) | null = null;
  onCommunityStart: ((song: Song) => void) | null = null;
  onShowcaseStart: ((song: Song) => void) | null = null;
  /** Guest mode: a locked community song (or its sign-in chip) was
   *  activated — leave guest mode via the auth screen. */
  onSignIn: (() => void) | null = null;
  onToggleGuestShowcase: ((song: Song) => void) | null = null;
  onRename: ((song: Song) => void) | null = null;
  onDelete: ((song: Song) => void) | null = null;
  onSetDifficulty: ((song: Song) => void) | null = null;
  onPublishCommunity: ((song: Song) => void) | null = null;
  onBookmark: ((song: Song) => void) | null = null;
  onBackToHome: (() => void) | null = null;

  /** Must be set before any load* call. */
  setGuestMode(guest: boolean): void {
    this._guestMode = guest;
  }
  /** Home main-menu action for a matched shortcut chord (home screen). */
  private _runHomeAction: ((action: 'prev' | 'next' | 'enter') => void) | null = null;

  /** Register how a matched shortcut behaves on the home main menu. */
  setHomeActions(run: ((action: 'prev' | 'next' | 'enter') => void) | null): void {
    this._runHomeAction = run;
  }

  private _runResultsAction: ((action: 'prev' | 'next' | 'enter') => void) | null = null;

  /** Register how a matched shortcut behaves on the end-of-game results screen. */
  setResultsActions(run: ((action: 'prev' | 'next' | 'enter') => void) | null): void {
    this._runResultsAction = run;
  }

  private _runSongListAction(action: 'prev' | 'next' | 'enter'): void {
    if (action === 'enter') {
      this._startSelected();
      return;
    }

    this._moveSelection(action === 'next' ? 1 : -1);
  }
  private _songListEl: HTMLElement;
  private _startBtn: HTMLButtonElement;
  private _freeplayScreen: HTMLElement;
  private _midiStatusEl: HTMLElement;
  private _controlsHintEl: HTMLElement | null;
  private _noteCapture: ((notes: string[]) => void) | null = null;
  private _heldMenuNotes = new Set<string>();

  constructor() {
    this._songListEl = document.getElementById('song-list')!;
    this._startBtn = document.getElementById('btn-start') as HTMLButtonElement;
    this._freeplayScreen = document.getElementById('freeplay-screen')!;
    this._midiStatusEl = document.getElementById('midi-status')!;
    this._controlsHintEl = this._freeplayScreen.querySelector('.controls-hint');
    this._render();
    // Same path as the keyboard Enter chord: the routing that picks
    // community/showcase/sign-in (and guest handling) lives in _startSong.
    this._startBtn.addEventListener('click', () => {
      this._startSelected();
    });

    const brandCorner = this._freeplayScreen.querySelector('.brand-corner') as HTMLElement;
    if (brandCorner) {
      brandCorner.addEventListener('click', () => {
        this._freeplayScreen.classList.remove('active');
        this.onBackToHome?.();
      });
    }

    document.addEventListener('click', () => {
      this._closeAllActionMenus();
    });
  }

  async loadLibrary(): Promise<void> {
    try {
      const menu = await fetchLibrary();
      this._groups = menu.categories.map((g) => ({
        id: g.id,
        name: g.name,
        items: g.songs.map((s) => ({ song: this._itemToSong(s), isCommunity: s.isCommunity })),
        total: g.total,
        loading: false,
      }));
      this._render();
    } catch (err) {
      reportError('Failed to load library', err);
    }
  }

  /** The songs arrive pre-parsed (with negative ids) from the guest store. */
  loadGuestLibrary(songs: Song[]): void {
    this._groups = [
      {
        id: null,
        name: 'My Imports',
        items: songs.map((song) => ({ song, isCommunity: false })),
        total: songs.length,
        loading: false,
      },
    ];
    this._render();
  }

  addGuestSong(song: Song): void {
    const group = this._groups.find((g) => g.id === null);

    if (group) {
      group.items.push({ song, isCommunity: false });
      group.total = group.items.length;
    } else {
      this._groups.push({
        id: null,
        name: 'My Imports',
        items: [{ song, isCommunity: false }],
        total: 1,
        loading: false,
      });
    }

    this._render();
  }

  async loadShowcaseSongs(): Promise<void> {
    try {
      const { songs } = await fetchGuestShowcaseSongs();
      this._showcaseSongs = songs.map((s) => this._itemToSong(s));
      this._render();
    } catch (err) {
      reportError('Failed to load guest showcase', err);
    }
  }

  async addSong(_song: Song): Promise<void> {
    await this.loadLibrary();
  }

  updateSong(updated: Song): void {
    for (const group of this._groups) {
      const idx = group.items.findIndex((i) => i.song.id === updated.id);

      if (idx !== -1) {
        group.items[idx].song = {
          ...group.items[idx].song,
          title: updated.title,
          artist: updated.artist,
          difficulty: updated.difficulty,
          publicCommunity: updated.publicCommunity,
          guestShowcase: updated.guestShowcase,
        };
        break;
      }
    }
    this._render();
  }

  removeSong(id: number): void {
    for (const group of this._groups) {
      const before = group.items.length;
      group.items = group.items.filter((i) => i.song.id !== id);

      if (group.items.length !== before) {
        group.total = Math.max(0, group.total - 1);
        break;
      }
    }
    this._groups = this._groups.filter((g) => g.total > 0);

    if (this._selectedSong?.id === id) {
      this._selectedSong = null;
      this._startBtn.disabled = true;
    }
    this._render();
  }

  updateSongStats(id: number, bestScore: number | null, lastScore?: number): void {
    for (const group of this._groups) {
      const item = group.items.find((i) => i.song.id === id);

      if (item) {
        item.song.bestScore = bestScore;
        if (lastScore !== undefined) {
          item.song.lastScore = lastScore;
        }
        this._render();
        return;
      }
    }
  }

  async loadCommunitySongs(): Promise<void> {
    this._communitySongs = [];
    this._communityOffset = 0;
    this._communityTotal = 0;
    await this._loadMoreCommunity();
  }

  private _itemToSong(s: SongSummary): Song {
    return {
      id: s.id,
      title: s.title,
      artist: s.artist || '',
      bpm: s.bpm,
      difficulty: s.difficulty,
      notes: [],
      imported: s.imported,
      importedByUserId: s.importedByUserId,
      importedByUsername: s.importedByUsername ?? null,
      categoryId: s.categoryId,
      lastPlayedAt: s.lastPlayedAt,
      bestScore: s.bestScore,
      lastScore: s.lastScore,
      publicCommunity: s.publicCommunity,
      communityBookmarked: s.communityBookmarked,
      bookmarkCount: s.bookmarkCount,
      guestShowcase: s.guestShowcase,
    } as Song;
  }

  private async _loadMoreCommunity(): Promise<void> {
    if (this._communityLoading) return;
    this._communityLoading = true;

    try {
      const result = await fetchCommunitySongs(COMMUNITY_PAGE_SIZE, this._communityOffset);
      const songs = result.songs.map((s) => this._itemToSong(s));

      this._communitySongs = [...this._communitySongs, ...songs];
      this._communityOffset += result.songs.length;
      this._communityTotal = result.total;
      this._render();
    } catch (err) {
      reportError('Failed to load community songs', err);
    } finally {
      this._communityLoading = false;
    }
  }

  private async _loadMoreCategory(categoryId: number | null): Promise<void> {
    const group = this._groups.find((g) => g.id === categoryId);
    if (!group || group.loading) return;
    group.loading = true;

    try {
      const result = await fetchLibraryCategorySongs(
        categoryId,
        CATEGORY_PAGE_SIZE,
        group.items.length,
      );
      group.items = [
        ...group.items,
        ...result.songs.map((s) => ({ song: this._itemToSong(s), isCommunity: s.isCommunity })),
      ];
      group.total = result.total;
      this._render();
    } catch (err) {
      reportError('Failed to load more songs', err);
    } finally {
      group.loading = false;
    }
  }

  updateBookmarkState(id: number, bookmarked: boolean): void {
    if (bookmarked) {
      this._communitySongs = this._communitySongs.filter((s) => s.id !== id);
      this._communityTotal = Math.max(0, this._communityTotal - 1);
      this._render();
      this.loadLibrary().catch((err) => reportError('Failed to reload library', err));

      return;
    }

    this.loadLibrary().catch((err) => reportError('Failed to reload library', err));
    this.loadCommunitySongs().catch((err) => reportError('Failed to reload community songs', err));
  }

  refreshAfterPublishChange(unpublished: boolean): void {
    this.loadCommunitySongs().catch((err) => reportError('Failed to reload community songs', err));

    if (unpublished) {
      this.loadLibrary().catch((err) => reportError('Failed to reload library', err));
    }
  }

  private _closeAllActionMenus(): void {
    const menus = this._songListEl.querySelectorAll('.song-actions-menu:not(.hidden)');
    for (const menu of menus) {
      menu.classList.add('hidden');
    }
  }

  private _loadCollapsed(): Set<string> {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);

      if (!raw) {
        return new Set();
      }

      return new Set(JSON.parse(raw) as string[]);
    } catch (err) {
      console.warn('Failed to load collapsed state:', err);
      return new Set();
    }
  }

  private _saveCollapsed(set: Set<string>): void {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set)));
    } catch (err) {
      console.warn('Failed to save collapsed state:', err);
    }
  }

  private _render(): void {
    this._songListEl.innerHTML = '';

    const hasGroups = this._groups.some((g) => g.items.length > 0);

    if (!hasGroups && this._communitySongs.length === 0 && this._showcaseSongs.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-song-list';
      empty.textContent = 'No songs yet. Import a MIDI to get started.';
      this._songListEl.appendChild(empty);
      this._startBtn.disabled = true;
      this._selectedSong = null;
      return;
    }

    for (const group of this._groups) {
      if (group.items.length > 0) {
        this._songListEl.appendChild(this._renderGroup(group));
      }
    }

    if (this._showcaseSongs.length > 0) {
      this._songListEl.appendChild(this._renderShowcaseSection());
    }

    if (this._communitySongs.length > 0) {
      this._songListEl.appendChild(this._renderCommunitySection());
    }

    const allSongs = [
      ...this._groups.flatMap((g) => g.items.map((i) => i.song)),
      ...this._showcaseSongs,
      ...this._communitySongs,
    ];

    if (this._selectedSong && !allSongs.some((s) => s.id === this._selectedSong?.id)) {
      this._selectedSong = null;
      this._startBtn.disabled = true;
    }

    if (!this._selectedSong) {
      const first = allSongs[0];

      if (first) this._autoSelect(first);
      else this._startBtn.disabled = true;
    } else {
      this._reapplySelection();
      this._startBtn.disabled = false;
    }
  }

  private _renderGroup(group: MenuGroup): HTMLElement {
    const collapsedSet = this._loadCollapsed();
    const key = group.id === null ? 'uncategorized' : `cat:${group.id}`;
    const isCollapsed = collapsedSet.has(key);

    const section = document.createElement('div');
    section.className = `category-section${isCollapsed ? ' collapsed' : ''}`;
    section.dataset.categoryKey = key;

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `<span>${group.name}</span><span><span class="category-count">${group.total}</span><span class="category-collapse-icon"></span></span>`;
    header.addEventListener('click', () => {
      const collapsedNow = section.classList.toggle('collapsed');

      if (collapsedNow) {
        collapsedSet.add(key);
      } else {
        collapsedSet.delete(key);
      }
      this._saveCollapsed(collapsedSet);
    });

    const songsWrap = document.createElement('div');
    songsWrap.className = 'category-songs';

    for (const { song, isCommunity } of group.items) {
      songsWrap.appendChild(
        isCommunity
          ? this._renderCommunitySong(song, { showCommunityLabel: true })
          : this._renderSong(song),
      );
    }

    section.appendChild(header);
    section.appendChild(songsWrap);

    if (group.items.length < group.total) {
      const loadMoreBtn = this._el(
        'button',
        'btn-link category-load-more',
        `Load more (${group.total - group.items.length} remaining)`,
      ) as HTMLButtonElement;
      loadMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._loadMoreCategory(group.id);
      });
      section.appendChild(loadMoreBtn);
    }

    return section;
  }

  private _renderShowcaseSection(): HTMLElement {
    const showcaseKey = 'guest-showcase';
    const collapsedSet = this._loadCollapsed();
    const isCollapsed = collapsedSet.has(showcaseKey);

    const section = document.createElement('div');
    section.className = `category-section showcase-section${isCollapsed ? ' collapsed' : ''}`;
    section.dataset.categoryKey = showcaseKey;

    const header = document.createElement('div');
    header.className = 'category-header showcase-header';
    header.innerHTML = `<span>Featured</span><span><span class="category-collapse-icon"></span></span>`;

    header.addEventListener('click', () => {
      const set = this._loadCollapsed();
      const collapsed = section.classList.toggle('collapsed');

      if (collapsed) {
        set.add(showcaseKey);
      } else {
        set.delete(showcaseKey);
      }

      this._saveCollapsed(set);
    });

    const songsWrap = document.createElement('div');
    songsWrap.className = 'category-songs';

    for (const song of this._showcaseSongs) {
      songsWrap.appendChild(this._renderCommunitySong(song, { showcase: true }));
    }

    section.appendChild(header);
    section.appendChild(songsWrap);

    return section;
  }

  private _renderCommunitySection(): HTMLElement {
    const communityKey = 'community';
    const collapsedSet = this._loadCollapsed();
    const isCollapsed = collapsedSet.has(communityKey);

    const section = document.createElement('div');
    section.className = `category-section community-section${isCollapsed ? ' collapsed' : ''}`;
    section.dataset.categoryKey = communityKey;

    const header = document.createElement('div');
    header.className = 'category-header community-header';
    header.innerHTML = `<span>Community</span><span><span class="category-count">${this._communityTotal}</span><span class="category-collapse-icon"></span></span>`;

    header.addEventListener('click', () => {
      const set = this._loadCollapsed();
      const collapsed = section.classList.toggle('collapsed');

      if (collapsed) {
        set.add(communityKey);
      } else {
        set.delete(communityKey);
      }

      this._saveCollapsed(set);
    });

    const songsWrap = document.createElement('div');
    songsWrap.className = 'category-songs';
    for (const song of this._communitySongs) {
      songsWrap.appendChild(this._renderCommunitySong(song));
    }

    section.appendChild(header);
    section.appendChild(songsWrap);

    if (this._communitySongs.length < this._communityTotal) {
      const loadMoreBtn = this._el(
        'button',
        'btn-link community-load-more',
        `Load more (${this._communityTotal - this._communitySongs.length} remaining)`,
      ) as HTMLButtonElement;
      loadMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._loadMoreCommunity();
      });
      section.appendChild(loadMoreBtn);
    }

    return section;
  }

  /** `showcase` renders the row as a Featured (guest-playable) item. In
   *  guest mode, locked community songs lose their bookmark button and
   *  carry a sign-in chip instead. */
  private _renderCommunitySong(
    song: Song,
    opts: { showCommunityLabel?: boolean; showcase?: boolean } = {},
  ): HTMLElement {
    const { showCommunityLabel, showcase } = opts;
    const el = this._el(
      'div',
      `song-item community-song${showcase ? ' showcase-song' : ''} ${NAV_ITEM_CLASS}`,
    );
    el.dataset.songId = song.id !== undefined ? String(song.id) : '';

    this._renderSongMeta(song, el, showCommunityLabel);

    if (song.importedByUsername && (!showCommunityLabel || showcase)) {
      el.appendChild(this._el('div', 'song-origin-user', `Shared by ${song.importedByUsername}`));
    }

    this._renderSongStats(song, el);

    if (!this._guestMode) {
      this._renderBookmarkButton(song, el);
    } else if (!showcase) {
      this._renderSignInChip(el);
    }

    if (showcase) {
      el.appendChild(this._el('span', 'song-community-label showcase-label', 'Featured'));
    }

    // Admins keep a menu on other users' songs so they can recalculate the
    // auto difficulty there (Set difficulty is their only option).
    if (!this._guestMode && isAdmin() && song.importedByUserId != null) {
      this._renderSongActions(song, el, { adminRecalc: true });
    }

    el.addEventListener('click', () => this._onSongClick(song, el));
    el.addEventListener('dblclick', () => this._startSong(song, true));

    return el;
  }

  /** The lock replacement on community rows. */
  private _renderSignInChip(el: HTMLElement): void {
    const chip = this._el(
      'button',
      'btn-ghost sign-in-chip',
      '\u{1F512} Sign in to play',
    ) as HTMLButtonElement;
    chip.type = 'button';
    chip.title = 'Create an account (or log in) to play community songs';
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.onSignIn) this.onSignIn();
    });
    chip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
    });
    el.appendChild(chip);
  }

  private _renderBookmarkButton(song: Song, el: HTMLElement): void {
    const bookmarked = song.communityBookmarked === true;
    const btn = this._el(
      'button',
      `bookmark-btn${bookmarked ? ' bookmarked' : ''}`,
      bookmarked ? '\u2605' : '\u2606',
    ) as HTMLButtonElement;
    btn.title = bookmarked ? 'Remove bookmark' : 'Bookmark this song';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.onBookmark) this.onBookmark(song);
    });
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
    });
    el.appendChild(btn);
  }

  private _renderSong(song: Song): HTMLElement {
    const el = this._el('div', `song-item ${NAV_ITEM_CLASS}${song.imported ? ' imported' : ''}`);
    el.dataset.songId = song.id !== undefined ? String(song.id) : '';

    this._renderSongMeta(song, el);
    this._renderSongStats(song, el);
    this._renderSongActions(song, el, this._guestMode ? { guestLocal: true } : {});

    el.addEventListener('click', () => this._onSongClick(song, el));
    el.addEventListener('dblclick', () => this._startSong(song, false));

    return el;
  }

  private _el(tag: string, className: string, text?: string): HTMLElement {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  private _actionOption(text: string, className: string, onClick: () => void): HTMLButtonElement {
    const btn = this._el('button', className, text) as HTMLButtonElement;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
    });
    return btn;
  }

  private _renderSongMeta(song: Song, el: HTMLElement, showCommunityLabel = false): void {
    const titleDiv = this._el('div', 'song-title', song.title);

    el.appendChild(titleDiv);
    el.appendChild(this._el('div', 'song-artist', song.artist || ''));
    el.appendChild(
      this._el('span', `song-difficulty difficulty-${song.difficulty}`, song.difficulty),
    );

    if (showCommunityLabel) {
      el.appendChild(this._el('span', 'song-community-label', 'Community'));
    }
  }

  private _renderSongStats(song: Song, el: HTMLElement): void {
    const lastPlayed = this._formatLastPlayed(song.lastPlayedAt);

    if (lastPlayed) {
      el.appendChild(this._el('div', 'song-last-played', lastPlayed));
    }

    if (song.bestScore != null || song.lastScore != null) {
      const parts: string[] = [];

      if (song.lastScore != null) {
        parts.push(`Last: ${formatScore(song.lastScore)}`);
      }

      if (song.bestScore != null) {
        parts.push(`Best: ${formatScore(song.bestScore)}`);
      }

      el.appendChild(this._el('div', 'song-scores', parts.join(' | ')));
    }

    if (song.bookmarkCount != null && song.bookmarkCount > 0) {
      el.appendChild(
        this._el(
          'div',
          'song-bookmark-count',
          `${song.bookmarkCount} bookmark${song.bookmarkCount === 1 ? '' : 's'}`,
        ),
      );
    }
  }

  /** `adminRecalc` renders the menu on a song the viewer doesn't own, with
   *  only the Set difficulty option (used by admins on community songs).
   *  `guestLocal` renders the shelf item for a guest: only Delete (removes
   *  it from the local guest store). */
  private _renderSongActions(
    song: Song,
    el: HTMLElement,
    opts: { adminRecalc?: boolean; guestLocal?: boolean } = {},
  ): void {
    const { adminRecalc, guestLocal } = opts;
    const actionsMenu = this._el('div', 'song-actions-menu hidden');

    const actionsBtn = this._el('button', 'song-actions-btn', '\u2026') as HTMLButtonElement;
    actionsBtn.title = 'Song actions';
    actionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const wasHidden = actionsMenu.classList.contains('hidden');
      this._closeAllActionMenus();
      if (wasHidden) {
        actionsMenu.classList.remove('hidden');
      }
    });
    actionsBtn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
    });

    if (guestLocal) {
      actionsMenu.appendChild(
        this._actionOption('Delete', 'song-action-option danger', () => {
          actionsMenu.classList.add('hidden');
          if (this.onDelete) this.onDelete(song);
        }),
      );
      el.appendChild(actionsBtn);
      el.appendChild(actionsMenu);
      return;
    }

    actionsMenu.appendChild(
      this._actionOption('Set difficulty', 'song-action-option', () => {
        actionsMenu.classList.add('hidden');
        if (this.onSetDifficulty) this.onSetDifficulty(song);
      }),
    );

    // Admin curation: feature any song for guest play, own or not.
    if (isAdmin() && this.onToggleGuestShowcase) {
      const isFeatured = song.guestShowcase === true;
      actionsMenu.appendChild(
        this._actionOption(
          isFeatured ? 'Remove from guest showcase' : 'Feature for guests',
          'song-action-option',
          () => {
            actionsMenu.classList.add('hidden');
            if (this.onToggleGuestShowcase) this.onToggleGuestShowcase(song);
          },
        ),
      );
    }

    if (!adminRecalc) {
      actionsMenu.appendChild(
        this._actionOption('Edit', 'song-action-option', () => {
          actionsMenu.classList.add('hidden');
          if (this.onRename) this.onRename(song);
        }),
      );
    }

    if (song.importedByUserId != null && !adminRecalc) {
      const isPublic = song.publicCommunity === true;
      actionsMenu.appendChild(
        this._actionOption(
          isPublic ? 'Unpublish from community' : 'Publish to community',
          'song-action-option',
          () => {
            actionsMenu.classList.add('hidden');
            if (this.onPublishCommunity) this.onPublishCommunity(song);
          },
        ),
      );

      actionsMenu.appendChild(
        this._actionOption('Delete', 'song-action-option danger', () => {
          actionsMenu.classList.add('hidden');
          if (this.onDelete) this.onDelete(song);
        }),
      );
    }

    el.appendChild(actionsBtn);
    el.appendChild(actionsMenu);
  }

  /** While rebinding, a capture callback swallows every incoming chord. */
  setNoteCapture(cb: ((notes: string[]) => void) | null): void {
    this._noteCapture = cb;
  }

  /** Clear all held notes (e.g. popups closing or navigation). */
  resetNoteHold(): void {
    this._heldMenuNotes.clear();
  }

  /** Route a piano note-on (MIDI or computer keyboard) to navigation
   *  shortcuts: the results screen buttons after a game, the song list while
   *  freeplay is up, or the menu callbacks (home main menu) otherwise. Popups and overlay screens suspend it. */
  handleNoteOn(note: string): void {
    this._heldMenuNotes.add(note);

    if (this._noteCapture) {
      this._noteCapture([...this._heldMenuNotes]);
      return;
    }

    if (document.querySelector('.popup:not(.hidden)')) return;

    const action = matchSongListAction(getSongListKeys(), [...this._heldMenuNotes]);

    if (!action) return;

    if (document.getElementById(RESULTS_SCREEN_ID)?.classList.contains('active')) {
      this._runResultsAction?.(action);
      return;
    }

    if (
      this._freeplayScreen.classList.contains('active') &&
      !document.querySelector('.screen.active:not(#freeplay-screen)')
    ) {
      this._runSongListAction(action);
      return;
    }

    this._runHomeAction?.(action);
  }

  handleNoteOff(note: string): void {
    this._heldMenuNotes.delete(note);

    if (this._noteCapture && this._heldMenuNotes.size === 0) {
      this._noteCapture([]);
    }
  }

  private _onSongClick(song: Song, el: HTMLElement): void {
    if (!el.classList.contains(FOCUS_CLASS)) {
      playMenuSound('next');
    }

    this._selectSong(song, el);
  }

  private _selectSong(song: Song, el: HTMLElement): void {
    this._selectedSong = song;
    setFocused(this._songItems(), el);
    this._startBtn.disabled = false;
  }

  private _startSong(song: Song, isCommunity: boolean): void {
    playMenuSound('enter');

    if (this._guestMode) {
      if (!isCommunity) {
        this.onStart?.(song);
        return;
      }

      if (song.guestShowcase === true) {
        this.onShowcaseStart?.(song);
      } else {
        this.onSignIn?.();
      }

      return;
    }

    if (isCommunity) {
      this.onCommunityStart?.(song);
    } else {
      this.onStart?.(song);
    }
  }

  private _songItems(): HTMLElement[] {
    return Array.from(this._songListEl.querySelectorAll<HTMLElement>('.song-item'));
  }

  private _visibleItems(): HTMLElement[] {
    return this._songItems().filter((el) => el.offsetParent !== null);
  }

  private _moveSelection(delta: number): void {
    const el = stepFocus(this._visibleItems(), delta);

    if (!el) return;

    const song = this._findSong(Number(el.dataset.songId));

    if (!song) return;

    this._selectSong(song, el);
    el.scrollIntoView({ block: 'nearest' });
  }

  private _startSelected(): void {
    const el = this._visibleItems().find((item) => item.classList.contains(FOCUS_CLASS));

    if (!el) return;

    const song = this._findSong(Number(el.dataset.songId));

    if (!song) return;

    this._startSong(song, el.classList.contains('community-song'));
  }

  private _findSong(id: number): Song | null {
    for (const group of this._groups) {
      const item = group.items.find((i) => i.song.id === id);

      if (item) return item.song;
    }
    return (
      this._showcaseSongs.find((s) => s.id === id) ??
      this._communitySongs.find((s) => s.id === id) ??
      null
    );
  }

  private _autoSelect(song: Song): void {
    this._selectedSong = song;
    const firstItem = this._songListEl.querySelector('.song-item') as HTMLElement | null;
    firstItem?.classList.add(FOCUS_CLASS);
    this._startBtn.disabled = false;
  }

  private _reapplySelection(): void {
    const items = this._songListEl.querySelectorAll('.song-item');

    for (const item of items) {
      const el = item as HTMLElement;

      if (el.dataset.songId === String(this._selectedSong?.id ?? '')) {
        el.classList.add(FOCUS_CLASS);
        return;
      }
    }
  }

  private _formatLastPlayed(ts: string | null | undefined): string {
    return formatRelativeTime(ts, 'Last played ');
  }

  show(): void {
    this._freeplayScreen.classList.add('active');
  }

  hide(): void {
    this._freeplayScreen.classList.remove('active');
  }

  setMidiStatus(connected: boolean, message: string): void {
    renderMidiStatus(this._midiStatusEl, connected, message);

    this._controlsHintEl?.classList.toggle('hidden', connected);
  }
}
