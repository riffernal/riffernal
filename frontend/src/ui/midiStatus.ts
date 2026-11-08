export const MIDI_STATUS_MAX_LENGTH = 36;

const CONNECTED_PREFIX = 'Connected: ';

export interface MidiStatusDisplay {
  text: string;
  full: string;
  truncated: boolean;
}

/** Cap the detected device names so a long device cannot overflow the layout.
 *  Other status messages keep their wording. The full message is kept for the
 *  hover title. */
export function shortenMidiStatus(
  message: string,
  maxLength: number = MIDI_STATUS_MAX_LENGTH,
): MidiStatusDisplay {
  if (!message.startsWith(CONNECTED_PREFIX) || message.length <= maxLength) {
    return { text: message, full: message, truncated: false };
  }

  return {
    text: `${message.slice(0, maxLength - 1).trimEnd()}…`,
    full: message,
    truncated: true,
  };
}

export function renderMidiStatus(el: HTMLElement, connected: boolean, message: string): void {
  const { text, full, truncated } = shortenMidiStatus(message);

  el.textContent = text;
  el.className = `midi-status${connected ? ' connected' : ''}`;

  if (truncated) {
    el.title = full;
  } else {
    el.removeAttribute('title');
  }
}
