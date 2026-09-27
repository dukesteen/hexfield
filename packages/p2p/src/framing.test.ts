import { describe, expect, test } from 'vitest';
import { MAX_FRAME_BYTES, MAX_MESSAGE_BYTES, MessageFramer } from './framing.js';

describe('bounded transport framing', () => {
  test.each([0, 1, 16_384, MAX_MESSAGE_BYTES])('round-trips %i bytes across channels', (size) => {
    const sender = new MessageFramer();
    const receiver = new MessageFramer();
    const message = Uint8Array.from({ length: size }, (_, index) => index % 251);
    const frames = sender.split(message);
    const first = frames[0];
    if (!first) throw new Error('Missing first frame');
    expect(frames.every((frame) => frame.byteLength <= MAX_FRAME_BYTES)).toBe(true);
    message.fill(0);
    let completed: Uint8Array | null = null;
    for (const frame of frames.toReversed()) completed = receiver.accept(frame, 10) ?? completed;
    expect(completed?.byteLength).toBe(size);
    expect(completed?.[size > 1 ? 1 : 0]).toBe(size === 0 ? undefined : size === 1 ? 0 : 1);
    expect(receiver.accept(first, 11)).toBeNull();
  });

  test('completed-message duplicates must match their original bytes', () => {
    const frame = new MessageFramer().split(new Uint8Array([1, 2, 3]))[0];
    if (!frame) throw new Error('Missing test frame');
    const receiver = new MessageFramer();
    expect(receiver.accept(frame, 0)).toEqual(new Uint8Array([1, 2, 3]));
    const changed = frame.slice();
    changed[8] = 9;
    expect(() => receiver.accept(changed, 1)).toThrow(/Conflicting completed/);
  });

  test('rejects conflicting duplicates and incompatible message shape', () => {
    const sender = new MessageFramer();
    const receiver = new MessageFramer();
    const frames = sender.split(new Uint8Array(20_000).fill(7));
    const first = frames[0];
    const second = frames[1];
    if (!first || !second) throw new Error('Missing test frames');
    expect(receiver.accept(first, 0)).toBeNull();
    expect(receiver.accept(first, 0)).toBeNull();
    const changed = first.slice();
    changed[8] = 8;
    expect(() => receiver.accept(changed, 0)).toThrow(/Conflicting duplicate/);
    const countChanged = second.slice();
    new DataView(countChanged.buffer).setUint16(6, 3);
    expect(() => receiver.accept(countChanged, 0)).toThrow(/Conflicting.*count/);
  });

  test('bounds malformed frames, partial messages, and expires stale fragments', () => {
    const receiver = new MessageFramer();
    const malformed = new Uint8Array(8);
    expect(() => receiver.accept(malformed, 0)).toThrow(/indices/);
    expect(() => receiver.accept(new Uint8Array(MAX_FRAME_BYTES + 1), 0)).toThrow(/Malformed/);
    const sender = new MessageFramer();
    for (let index = 0; index < 8; index++) {
      const first = sender.split(new Uint8Array(20_000))[0];
      if (!first) throw new Error('Missing frame');
      expect(receiver.accept(first, 0)).toBeNull();
    }
    const ninth = sender.split(new Uint8Array(20_000))[0];
    if (!ninth) throw new Error('Missing ninth frame');
    expect(() => receiver.accept(ninth, 0)).toThrow(/Too many partial/);
    expect(() => receiver.accept(ninth, 30_001)).toThrow(/timed out/);
    expect(receiver.accept(ninth, 30_001)).toBeNull();
    expect(() => sender.split(new Uint8Array(MAX_MESSAGE_BYTES + 1))).toThrow(/1 MiB/);
  });
});
