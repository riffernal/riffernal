import { type Game, GameState, LoopDefinitionState } from '../../game/Game.js';
import type { Renderer } from '../../game/rendering/Renderer.js';
import { formatTimePrecise } from '../../utils/helpers.js';
import { NOTE_NAMES } from '../../utils/notes.js';

const TOOLTIP_OFFSET_PX = 14;

function pianoNoteAtPoint(game: Game, renderer: Renderer, x: number, y: number): string | null {
  const candidates = NOTE_NAMES.filter((name) => name.includes('#')).concat(
    NOTE_NAMES.filter((name) => !name.includes('#')),
  );

  for (const name of candidates) {
    const layout = renderer.pianoKeyLayout(name, game.usedNoteRange);

    if (
      layout.width > 0 &&
      x >= layout.x &&
      x <= layout.x + layout.width &&
      y >= layout.y &&
      y <= layout.y + layout.height
    ) {
      return name;
    }
  }

  return null;
}

// One element shared by every canvas, so only a single tooltip can be visible.
function getTimeTooltip(): HTMLElement {
  const existing = document.querySelector<HTMLElement>('.pixel-tooltip');

  if (existing) return existing;

  const el = document.createElement('div');
  el.className = 'pixel-tooltip';
  el.hidden = true;
  document.body.appendChild(el);

  return el;
}

export function setupHoverCursor(
  game: Game,
  targetCanvas: HTMLCanvasElement,
  targetRenderer: Renderer,
): void {
  let hoverRAF: number | null = null;
  const tooltip = getTimeTooltip();

  targetCanvas.addEventListener('mousemove', (e) => {
    if (hoverRAF !== null) return;
    hoverRAF = requestAnimationFrame(() => {
      hoverRAF = null;

      if (game.state !== GameState.Playing) {
        targetCanvas.style.cursor = '';
        tooltip.hidden = true;

        return;
      }

      const rect = targetCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const pianoNote = pianoNoteAtPoint(game, targetRenderer, x, y);

      if (pianoNote) {
        targetCanvas.style.cursor = 'default';
        tooltip.textContent = pianoNote;
        tooltip.style.left = `${e.clientX + TOOLTIP_OFFSET_PX}px`;
        tooltip.style.top = `${e.clientY + TOOLTIP_OFFSET_PX}px`;
        tooltip.hidden = false;

        return;
      }

      const inLoopDefine =
        game.loopDefinitionState === LoopDefinitionState.Start ||
        game.loopDefinitionState === LoopDefinitionState.End;
      const radius = inLoopDefine ? 50 : 30;
      const note = game.noteManager.findNearestNoteByClick(x, y, targetRenderer, radius);
      targetCanvas.style.cursor = note ? 'pointer' : 'crosshair';

      if (!note) {
        tooltip.hidden = true;

        return;
      }

      tooltip.textContent = formatTimePrecise(note.time);
      tooltip.style.left = `${e.clientX + TOOLTIP_OFFSET_PX}px`;
      tooltip.style.top = `${e.clientY + TOOLTIP_OFFSET_PX}px`;
      tooltip.hidden = false;
    });
  });

  targetCanvas.addEventListener('mouseleave', () => {
    if (hoverRAF !== null) {
      cancelAnimationFrame(hoverRAF);
      hoverRAF = null;
    }

    targetCanvas.style.cursor = 'crosshair';
    tooltip.hidden = true;
  });
}
