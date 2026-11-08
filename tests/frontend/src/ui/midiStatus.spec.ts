import { describe, expect, test } from 'bun:test';
import {
  MIDI_STATUS_MAX_LENGTH,
  renderMidiStatus,
  shortenMidiStatus,
} from '../../../../frontend/src/ui/midiStatus.js';

function fakeStatusEl(): HTMLElement {
  const el = {
    textContent: '',
    className: '',
    title: '',
    removeAttribute(name: string) {
      if (name === 'title') el.title = '';
    },
  };

  return el as unknown as HTMLElement;
}

describe('shortenMidiStatus', () => {
  test('leaves short messages untouched', () => {
    expect(shortenMidiStatus('Connected: MPK mini 3')).toEqual({
      text: 'Connected: MPK mini 3',
      full: 'Connected: MPK mini 3',
      truncated: false,
    });
  });

  test('never shortens non-device status messages', () => {
    const message = 'Computer keyboard (no MIDI keyboard detected)';

    expect(shortenMidiStatus(message)).toEqual({
      text: message,
      full: message,
      truncated: false,
    });
  });

  test('caps long device names at the max length with an ellipsis', () => {
    const message = `Connected: ${'Very Long Device Name '.repeat(5).trim()}`;
    const { text, full, truncated } = shortenMidiStatus(message);

    expect(truncated).toBe(true);
    expect(text.startsWith('Connected: ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MIDI_STATUS_MAX_LENGTH);
    expect(text.endsWith('…')).toBe(true);
    expect(message.startsWith(text.slice(0, -1).trimEnd())).toBe(true);
    expect(full).toBe(message);
  });
});

describe('renderMidiStatus', () => {
  test('shows the short name and keeps the full one as the hover title', () => {
    const el = fakeStatusEl();
    const message = `Connected: ${'Very Long Device Name '.repeat(5).trim()}`;

    renderMidiStatus(el, true, message);

    expect(el.textContent!.length).toBeLessThanOrEqual(MIDI_STATUS_MAX_LENGTH);
    expect(el.textContent!.endsWith('…')).toBe(true);
    expect(el.title).toBe(message);
    expect(el.className).toBe('midi-status connected');
  });

  test('clears a stale title when the device name is short', () => {
    const el = fakeStatusEl();
    el.title = 'Connected: Old Device With A Very Long Name';

    renderMidiStatus(el, false, 'No MIDI device - use keyboard');

    expect(el.textContent).toBe('No MIDI device - use keyboard');
    expect(el.title).toBe('');
    expect(el.className).toBe('midi-status');
  });
});
