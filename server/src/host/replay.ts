import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleForZoomName, type Scenario } from '@kaki/shared';
import type { Hub } from '../hub';

/** One scripted transcript line, `at` seconds after the meeting starts. */
export interface ReplayLine {
  at: number;
  speaker: string;
  text: string;
}

const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios/', import.meta.url));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a replay script: every speaker is an attendee and lines are in time order. */
export function parseReplay(value: unknown, scenario: Scenario): ReplayLine[] {
  if (!isObject(value) || !Array.isArray(value.lines)) throw new Error('replay must have a "lines" array');

  const problems: string[] = [];
  let previousAt = 0;
  const lines = value.lines.map((line: unknown, index): ReplayLine => {
    if (
      !isObject(line) ||
      typeof line.at !== 'number' ||
      !Number.isFinite(line.at) ||
      typeof line.speaker !== 'string' ||
      typeof line.text !== 'string' ||
      line.text.trim().length === 0
    ) {
      problems.push(`lines[${index}] must have a numeric "at", a "speaker" and non-empty "text"`);
      return { at: 0, speaker: '', text: '' };
    }
    if (line.at < previousAt) problems.push(`lines[${index}].at goes back in time`);
    if (roleForZoomName(scenario, line.speaker) === undefined) {
      problems.push(`lines[${index}].speaker "${line.speaker}" is not an attendee's Zoom name`);
    }
    previousAt = line.at;
    return { at: line.at, speaker: line.speaker, text: line.text };
  });

  if (problems.length > 0) throw new Error(problems.join('; '));
  return lines;
}

/** Load and validate scenarios/<scenario id>/replay/transcript.json. */
export async function loadReplay(scenario: Scenario, scenariosDir = SCENARIOS_DIR): Promise<ReplayLine[]> {
  const file = path.join(scenariosDir, scenario.id, 'replay', 'transcript.json');
  try {
    return parseReplay(JSON.parse(await readFile(file, 'utf8')), scenario);
  } catch (error) {
    throw new Error(`Replay file ${file} is unusable: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/** Options for playing a replay into the hub. */
export interface ReplayOptions {
  lines: ReplayLine[];
  hub: Hub;
  /** 2 plays twice as fast as the script's timings. */
  speed?: number;
  now?: () => number;
}

/**
 * Publish each line as a TRANSCRIPT_CHUNK at its scripted time, like a live feed would.
 * Returns a function that stops the replay.
 */
export function startReplay({ lines, hub, speed = 1, now = Date.now }: ReplayOptions): () => void {
  if (!(speed > 0)) throw new Error(`Replay speed must be positive, got ${speed}`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let next = 0;
  const startedAt = now();

  function playDue(): void {
    timer = undefined;
    const elapsedScriptSeconds = ((now() - startedAt) / 1000) * speed;
    while (next < lines.length && lines[next]!.at <= elapsedScriptSeconds) {
      const line = lines[next]!;
      next += 1;
      hub.publish({
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'screen' },
        payload: { speaker: line.speaker, text: line.text, timestamp: new Date(now()).toISOString() },
      });
    }
    scheduleNext();
  }

  function scheduleNext(): void {
    const line = lines[next];
    if (line === undefined) return;
    const dueAt = startedAt + (line.at / speed) * 1000;
    timer = setTimeout(playDue, Math.max(0, dueAt - now()));
  }

  scheduleNext();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    next = lines.length;
  };
}
