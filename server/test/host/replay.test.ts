import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import { loadReplay, parseReplay, startReplay, type ReplayLine } from '../../src/host/replay';
import { loadScenario } from '../../src/loadScenario';
import { testScenario } from '../fixtures/scenario';

function recordingHub(): Hub & { published: KakiEvent[] } {
  const published: KakiEvent[] = [];
  return {
    published,
    publish: (event) => published.push(event),
    subscribe: () => () => {},
    onCommand: () => {},
    close: () => {},
  };
}

const lines: ReplayLine[] = [
  { at: 0, speaker: 'Ada (Chef)', text: 'Morning.' },
  { at: 10, speaker: 'Bao (Cashier)', text: 'Till is ready.' },
  { at: 10, speaker: 'Ada (Chef)', text: 'Oven is not.' },
  { at: 30, speaker: 'Bao (Cashier)', text: 'Let us call the repair man.' },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('replay script', () => {
  it('ships a valid Pixel Kampung replay', async () => {
    const scenario = await loadScenario('pixel-kampung');
    const loaded = await loadReplay(scenario);
    expect(loaded.length).toBeGreaterThan(20);
  });

  it('rejects unknown speakers, lines out of order and empty text', () => {
    expect(() => parseReplay({ lines: [{ at: 0, speaker: 'Zed', text: 'Hi' }] }, testScenario)).toThrow(/Zed/);
    expect(() =>
      parseReplay(
        {
          lines: [
            { at: 5, speaker: 'Ada (Chef)', text: 'a' },
            { at: 1, speaker: 'Ada (Chef)', text: 'b' },
          ],
        },
        testScenario,
      ),
    ).toThrow(/back in time/);
    expect(() => parseReplay({ lines: [{ at: 0, speaker: 'Ada (Chef)', text: ' ' }] }, testScenario)).toThrow();
    expect(() => parseReplay([], testScenario)).toThrow(/lines/);
  });
});

describe('replay feed', () => {
  it('publishes each line as a transcript chunk at its scripted time, scaled by speed', () => {
    vi.useFakeTimers();
    const hub = recordingHub();
    const texts = () => hub.published.map((event) => (event.type === 'TRANSCRIPT_CHUNK' ? event.payload.text : ''));

    startReplay({ lines, hub, speed: 2 });
    vi.advanceTimersByTime(0);
    expect(texts()).toEqual(['Morning.']);

    vi.advanceTimersByTime(4_999);
    expect(texts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(texts()).toEqual(['Morning.', 'Till is ready.', 'Oven is not.']);

    vi.advanceTimersByTime(10_000);
    expect(texts()).toHaveLength(4);
    expect(hub.published[0]).toMatchObject({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'screen' },
      payload: { speaker: 'Ada (Chef)' },
    });
  });

  it('stops publishing once stopped', () => {
    vi.useFakeTimers();
    const hub = recordingHub();

    const stop = startReplay({ lines, hub });
    vi.advanceTimersByTime(0);
    stop();
    vi.advanceTimersByTime(60_000);

    expect(hub.published).toHaveLength(1);
  });
});
