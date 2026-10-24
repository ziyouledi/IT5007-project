import { llmFromEnv } from '../llm';
import { scenarioFolder } from '../loadScenario';
import type { KakiModule } from '../modules';
import { createMeetingModule } from './meeting';

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

const replay = process.env.KAKI_REPLAY === '1';

/** Modules the Host team plugs into the meeting server. */
export const hostModules: KakiModule[] = [
  createMeetingModule({
    llm: llmFromEnv(),
    replay: replay ? scenarioFolder() : undefined,
    // A live meeting always runs in real time.
    speed: replay ? positiveNumber('KAKI_REPLAY_SPEED', 1) : 1,
    notetakerIntervalMs: positiveNumber('KAKI_NOTETAKER_INTERVAL_MS', 7_000),
  }),
];
