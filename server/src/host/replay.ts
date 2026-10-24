import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { roleForZoomName, type Scenario } from '@kaki/shared';
import type { Hub } from '../hub';
import { scenarioDir } from '../loadScenario';

/**
 * One scripted transcript line, `at` seconds after the meeting starts. `agendaIndex` marks the
 * line where a new agenda item begins, so a replay moves the agenda exactly on cue.
 */
export interface ReplayLine {
  at: number;
  speaker: string;
  text: string;
  agendaIndex?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a replay script: every speaker is an attendee, lines are in time order, and agenda
 * markers only move forward through the scenario's agenda.
 */
export function parseReplay(value: unknown, scenario: Scenario): ReplayLine[] {
  if (!isObject(value) || !Array.isArray(value.lines)) throw new Error('replay must have a "lines" array');

  const problems: string[] = [];
  let previousAt = 0;
  let previousAgendaIndex = 0;
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
    if (line.agendaIndex === undefined) return { at: line.at, speaker: line.speaker, text: line.text };

    if (
      !Number.isInteger(line.agendaIndex) ||
      (line.agendaIndex as number) <= previousAgendaIndex ||
      (line.agendaIndex as number) >= scenario.agenda.length
    ) {
      problems.push(`lines[${index}].agendaIndex must be a later agenda item than the one before`);
    } else {
      previousAgendaIndex = line.agendaIndex as number;
    }
    return { at: line.at, speaker: line.speaker, text: line.text, agendaIndex: line.agendaIndex as number };
  });

  if (problems.length > 0) throw new Error(problems.join('; '));
  return lines;
}

/** Load and validate `replay/transcript.json` from the scenario's folder. */
export async function loadReplay(scenario: Scenario, folder: string): Promise<ReplayLine[]> {
  const file = path.join(scenarioDir(folder), 'replay', 'transcript.json');
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
  /** Called with a line's agenda marker just before that line is published. */
  onAgenda?: (agendaIndex: number) => void;
  /** Called once, after the last line is published. */
  onEnd?: () => void;
}

/**
 * Publish each line as a TRANSCRIPT_CHUNK at its scripted time, like a live feed would.
 * Returns a function that stops the replay.
 */
export function startReplay({ lines, hub, speed = 1, now = Date.now, onAgenda, onEnd }: ReplayOptions): () => void {
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
      if (line.agendaIndex !== undefined) onAgenda?.(line.agendaIndex);
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
    if (line === undefined) {
      onEnd?.();
      return;
    }
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
