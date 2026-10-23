import {
  ACTION_KINDS,
  isActionKind,
  isRoleIn,
  isSuggestInput,
  roleForZoomName,
  roleLabel,
  type Question,
  type Role,
  type Scenario,
  type SuggestInput,
} from '@kaki/shared';
import { LlmError, type ChatMessage, type LlmClient } from '../llm';
import type { TaskStore } from '../tasks';

/** Rough speaking rate used to turn transcript words into talk time. */
const WORDS_PER_SECOND = 2.5;
/** A role is quiet when it has under this share of talk time... */
const QUIET_SHARE = 0.1;
/** ...once the meeting has at least this much talk overall. */
const QUIET_MIN_TOTAL_SECONDS = 60;
/** Unsent lines kept while the LLM is down; older ones are dropped. */
const MAX_PENDING_LINES = 200;

interface TranscriptLine {
  speaker: string;
  role?: Role;
  text: string;
}

/** How the notetaker's last LLM pass went. */
export type NotetakerStatus = 'waiting' | 'ok' | 'stale' | 'off';

/** The notetaker's part of the Meeting Record. */
export interface NotetakerState {
  openQuestions: Question[];
  /** Talk time per role for one agenda item. */
  talkSecondsFor(agendaIndex: number): Partial<Record<Role, number>>;
  /** Attendee roles with little talk time across the meeting so far. */
  quietRoles: Role[];
  status: NotetakerStatus;
  lastError?: string;
}

/** Turns new transcript into the Meeting Record and suggests tasks through the task store. */
export interface Notetaker {
  addChunk(chunk: { speaker: string; text: string }): void;
  /** Send transcript added since the last pass to the LLM; does nothing if a pass is running. */
  run(): Promise<void>;
  state(): NotetakerState;
}

/** What the notetaker needs; without `llm` it only keeps talk time. */
export interface NotetakerOptions {
  scenario: Scenario;
  tasks: TaskStore;
  llm?: LlmClient;
  /** The agenda item the meeting is on now. */
  agendaIndex: () => number;
  /** Called when the LLM hears the meeting move on to a later agenda item. */
  onAgendaIndex?: (agendaIndex: number) => void;
}

interface NotetakerReply {
  agendaIndex?: number;
  newQuestions: Array<{ text: string; forRole?: Role }>;
  answeredQuestionIds: string[];
  newTasks: SuggestInput[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function estimateTalkSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, words / WORDS_PER_SECOND);
}

// Models sometimes wrap JSON in a ```json fence even when asked not to.
function stripFence(text: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return match === null ? text : match[1]!;
}

/** Parse the LLM's JSON reply, dropping any item that does not fit the scenario. */
export function parseNotetakerReply(text: string, scenario: Scenario): NotetakerReply {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(text));
  } catch (error) {
    throw new LlmError('Notetaker reply is not valid JSON', { cause: error });
  }
  if (!isObject(json)) throw new LlmError('Notetaker reply must be a JSON object');

  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  const newQuestions = list(json.newQuestions).flatMap((question) => {
    if (!isObject(question) || typeof question.text !== 'string' || question.text.trim() === '') return [];
    return [isRoleIn(scenario, question.forRole) ? { text: question.text, forRole: question.forRole } : { text: question.text }];
  });

  const answeredQuestionIds = list(json.answeredQuestionIds).filter(
    (id): id is string => typeof id === 'string',
  );

  const newTasks = list(json.newTasks).flatMap((task) => {
    if (!isObject(task)) return [];
    // An unknown action kind still leaves a task the assignee can do by hand.
    const candidate = { ...task, actionKind: isActionKind(task.actionKind) ? task.actionKind : undefined };
    if (!isSuggestInput(candidate, scenario)) return [];
    const { title, context, suggestedAssignee, actionKind } = candidate;
    return [actionKind === undefined ? { title, context, suggestedAssignee } : { title, context, suggestedAssignee, actionKind }];
  });

  const agendaIndex =
    Number.isInteger(json.agendaIndex) && (json.agendaIndex as number) >= 0 && (json.agendaIndex as number) < scenario.agenda.length
      ? (json.agendaIndex as number)
      : undefined;

  return { agendaIndex, newQuestions, answeredQuestionIds, newTasks };
}

function systemPrompt(scenario: Scenario): string {
  const roles = scenario.roles.map((role) => {
    const people = scenario.attendees.filter((attendee) => attendee.role === role.id).map((a) => a.name);
    return `- ${role.id}: ${role.label}${people.length > 0 ? ` (${people.join(', ')})` : ''}`;
  });
  const agenda = scenario.agenda.map(
    (item, index) => `${index}. ${item.title} (${item.minutes} min, owner: ${item.ownerRole})`,
  );

  return [
    `You are the notetaker for "${scenario.meetingTitle}" at ${scenario.organisation}.`,
    'You read new transcript lines and update the meeting record. Reply with one JSON object only.',
    '',
    'Roles (use the id on the left):',
    ...roles,
    '',
    'Agenda (use the number on the left):',
    ...agenda,
    '',
    'Action kinds:',
    '- gitea_issue: a bug or engineering task to file in the issue tracker',
    '- mattermost_post: an announcement or update for the team chat',
    '- email: a message to someone outside the team',
    '',
    'Reply shape:',
    '{"agendaIndex": number, "newQuestions": [{"text": string, "forRole": role id}],',
    ' "answeredQuestionIds": [string], "newTasks": [{"title": string, "context": string,',
    ` "suggestedAssignee": role id, "actionKind": ${ACTION_KINDS.map((kind) => `"${kind}"`).join(' | ')}}]}`,
    '',
    'Rules:',
    '- agendaIndex: the agenda item being discussed at the end of the new lines.',
    '- newQuestions: factual questions someone asked that nobody answered in the lines. forRole is the role best placed to answer.',
    '- answeredQuestionIds: ids of open questions that the new lines answer.',
    '- newTasks: concrete follow-up work somebody committed to or asked for. suggestedAssignee is the role that should own it.',
    '  Omit actionKind when none fits. Never repeat a question or task that is already listed.',
    '- Use empty arrays when there is nothing new.',
  ].join('\n');
}

function speakerLabel(line: TranscriptLine, scenario: Scenario): string {
  return line.role === undefined ? line.speaker : `${line.speaker} (${roleLabel(scenario, line.role)})`;
}

function userPrompt(
  scenario: Scenario,
  agendaIndex: number,
  openQuestions: Question[],
  taskTitles: string[],
  lines: TranscriptLine[],
): string {
  return [
    `Current agenda item: ${agendaIndex}`,
    'Open questions:',
    ...(openQuestions.length === 0 ? ['(none)'] : openQuestions.map((q) => `- ${q.id}: ${q.text}`)),
    'Tasks already suggested:',
    ...(taskTitles.length === 0 ? ['(none)'] : taskTitles.map((title) => `- ${title}`)),
    '',
    'New transcript lines:',
    ...lines.map((line) => `[${speakerLabel(line, scenario)}] ${line.text}`),
  ].join('\n');
}

/** Create the notetaker; call `run` every 5–10 s while the meeting is on. */
export function createNotetaker({ scenario, tasks, llm, agendaIndex, onAgendaIndex }: NotetakerOptions): Notetaker {
  let pending: TranscriptLine[] = [];
  let running = false;
  let openQuestions: Question[] = [];
  let questionCount = 0;
  let status: NotetakerStatus = llm === undefined ? 'off' : 'waiting';
  let lastError: string | undefined;
  const talkByItem = new Map<number, Partial<Record<Role, number>>>();

  function addTalk(index: number, role: Role, seconds: number): void {
    const item = talkByItem.get(index) ?? {};
    item[role] = (item[role] ?? 0) + seconds;
    talkByItem.set(index, item);
  }

  function quietRoles(): Role[] {
    const totals = new Map<Role, number>();
    for (const item of talkByItem.values()) {
      for (const [role, seconds] of Object.entries(item)) totals.set(role, (totals.get(role) ?? 0) + (seconds ?? 0));
    }
    const total = [...totals.values()].reduce((sum, seconds) => sum + seconds, 0);
    if (total < QUIET_MIN_TOTAL_SECONDS) return [];
    const attending = new Set(scenario.attendees.map((attendee) => attendee.role));
    return scenario.roles
      .map((role) => role.id)
      .filter((role) => attending.has(role) && (totals.get(role) ?? 0) / total < QUIET_SHARE);
  }

  function apply(reply: NotetakerReply): void {
    const answered = new Set(reply.answeredQuestionIds);
    openQuestions = openQuestions.filter((question) => !answered.has(question.id));

    const knownQuestions = new Set(openQuestions.map((question) => normalize(question.text)));
    for (const question of reply.newQuestions) {
      const key = normalize(question.text);
      if (knownQuestions.has(key)) continue;
      knownQuestions.add(key);
      questionCount += 1;
      openQuestions.push({ id: `q-${questionCount}`, ...question });
    }

    const knownTasks = new Set(tasks.list().map((task) => normalize(task.title)));
    for (const task of reply.newTasks) {
      const key = normalize(task.title);
      if (knownTasks.has(key)) continue;
      knownTasks.add(key);
      try {
        tasks.suggest(task);
      } catch (error) {
        console.error('kaki notetaker: could not suggest a task', error);
      }
    }

    if (reply.agendaIndex !== undefined && reply.agendaIndex > agendaIndex()) onAgendaIndex?.(reply.agendaIndex);
  }

  return {
    addChunk({ speaker, text }) {
      const role = roleForZoomName(scenario, speaker);
      if (role !== undefined) addTalk(agendaIndex(), role, estimateTalkSeconds(text));
      if (llm === undefined) return;
      pending.push(role === undefined ? { speaker, text } : { speaker, role, text });
      if (pending.length > MAX_PENDING_LINES) pending = pending.slice(-MAX_PENDING_LINES);
    },

    async run() {
      if (llm === undefined || running || pending.length === 0) return;
      running = true;
      const batch = pending;
      pending = [];

      try {
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt(scenario) },
          {
            role: 'user',
            content: userPrompt(
              scenario,
              agendaIndex(),
              openQuestions,
              tasks.list().map((task) => task.title),
              batch,
            ),
          },
        ];
        apply(parseNotetakerReply(await llm.complete(messages, { json: true }), scenario));
        status = 'ok';
        lastError = undefined;
      } catch (error) {
        // Keep the last good record and try these lines again on the next pass.
        pending = [...batch, ...pending].slice(-MAX_PENDING_LINES);
        status = 'stale';
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`kaki notetaker: keeping the last good record; ${lastError}`);
      } finally {
        running = false;
      }
    },

    state() {
      return {
        openQuestions: [...openQuestions],
        talkSecondsFor: (index) => ({ ...(talkByItem.get(index) ?? {}) }),
        quietRoles: quietRoles(),
        status,
        lastError,
      };
    },
  };
}
