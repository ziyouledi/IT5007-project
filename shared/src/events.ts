import type { Role } from './roles';
import { isRoleIn, type Scenario } from './scenario';
import type { Fact } from './services';
import { isTask, type Task } from './task';

/** Who should receive an event: the shared screen, one role's phone, or everyone. */
export type Audience = { kind: 'screen' } | { kind: 'role'; role: Role } | { kind: 'all' };

/** An open question in the meeting record, optionally owned by one role. */
export interface Question {
  id: string;
  text: string;
  forRole?: Role;
}

/**
 * How the notetaker's last LLM pass went: still waiting for its first pass, ok, stale (the last
 * pass failed, so questions and tasks may be out of date), or off (no LLM configured).
 */
export type NotetakerStatus = 'waiting' | 'ok' | 'stale' | 'off';

/** Every notetaker status. */
export const NOTETAKER_STATUSES: readonly NotetakerStatus[] = ['waiting', 'ok', 'stale', 'off'];

/** The event types the meeting protocol knows about. */
export type KakiEventType =
  | 'TRANSCRIPT_CHUNK'
  | 'MEETING_RECORD_UPDATED'
  | 'HOST_SPEECH_TRIGGERED'
  | 'NUDGE'
  | 'FACT_FOUND'
  | 'TASK_UPDATED'
  | 'COMMAND_REJECTED';

type KakiEventOf<T extends KakiEventType, P> = { type: T; payload: P; audience: Audience };

/** One message on the Kaki meeting protocol, with its audience. */
export type KakiEvent =
  | KakiEventOf<'TRANSCRIPT_CHUNK', { speaker: string; text: string; timestamp: string }>
  | KakiEventOf<
      'MEETING_RECORD_UPDATED',
      {
        agendaIndex: number;
        openQuestions: Question[];
        elapsedSeconds: number;
        speakerTalkSeconds: Partial<Record<Role, number>>;
        /** Optional: whether open questions and tasks are up to date. */
        notetakerStatus?: NotetakerStatus;
        /** Optional: attendee roles that have barely spoken so far. */
        quietRoles?: Role[];
      }
    >
  | KakiEventOf<'HOST_SPEECH_TRIGGERED', { kind: 'OPENING' | 'TIMEOUT' | 'CLOSING'; text: string }>
  | KakiEventOf<'NUDGE', { text: string }>
  | KakiEventOf<'FACT_FOUND', { questionId: string; question: string; facts: Fact[] }>
  | KakiEventOf<'TASK_UPDATED', { task: Task }>
  | KakiEventOf<'COMMAND_REJECTED', { commandType: string; reason: string }>;

const KAKI_EVENT_TYPES: readonly KakiEventType[] = [
  'TRANSCRIPT_CHUNK',
  'MEETING_RECORD_UPDATED',
  'HOST_SPEECH_TRIGGERED',
  'NUDGE',
  'FACT_FOUND',
  'TASK_UPDATED',
  'COMMAND_REJECTED',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

// True for a finite number that is zero or more.
function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// True when every key is a role in the scenario and every value is a finite, non-negative number.
function isSpeakerTalkSeconds(value: unknown, scenario: Scenario): value is Partial<Record<Role, number>> {
  return (
    isObject(value) &&
    Object.entries(value).every(([role, seconds]) => isRoleIn(scenario, role) && isNonNegativeFinite(seconds))
  );
}

function isNotetakerStatus(value: unknown): value is NotetakerStatus {
  return typeof value === 'string' && (NOTETAKER_STATUSES as readonly string[]).includes(value);
}

function isFact(value: unknown): value is Fact {
  return isObject(value) && isString(value.text) && isString(value.source) && isString(value.date);
}

function isQuestion(value: unknown, scenario: Scenario): value is Question {
  return (
    isObject(value) &&
    isString(value.id) &&
    isString(value.text) &&
    (value.forRole === undefined || isRoleIn(scenario, value.forRole))
  );
}

function isAudience(value: unknown, scenario: Scenario): value is Audience {
  if (!isObject(value)) return false;
  if (value.kind === 'screen' || value.kind === 'all') return true;
  return value.kind === 'role' && isRoleIn(scenario, value.role);
}

function isKnownEventType(value: unknown): value is KakiEventType {
  return typeof value === 'string' && (KAKI_EVENT_TYPES as readonly string[]).includes(value);
}

type PayloadCheck = (payload: Record<string, unknown>, scenario: Scenario) => boolean;

const PAYLOAD_CHECKS: Record<KakiEventType, PayloadCheck> = {
  TRANSCRIPT_CHUNK: (payload) =>
    isString(payload.speaker) && isString(payload.text) && isString(payload.timestamp),
  MEETING_RECORD_UPDATED: (payload, scenario) =>
    Number.isInteger(payload.agendaIndex) &&
    Array.isArray(payload.openQuestions) &&
    payload.openQuestions.every((question) => isQuestion(question, scenario)) &&
    isNonNegativeFinite(payload.elapsedSeconds) &&
    isSpeakerTalkSeconds(payload.speakerTalkSeconds, scenario) &&
    (payload.notetakerStatus === undefined || isNotetakerStatus(payload.notetakerStatus)) &&
    (payload.quietRoles === undefined ||
      (Array.isArray(payload.quietRoles) && payload.quietRoles.every((role) => isRoleIn(scenario, role)))),
  HOST_SPEECH_TRIGGERED: (payload) =>
    (payload.kind === 'OPENING' || payload.kind === 'TIMEOUT' || payload.kind === 'CLOSING') &&
    isString(payload.text),
  NUDGE: (payload) => isString(payload.text),
  FACT_FOUND: (payload) =>
    isString(payload.questionId) &&
    isString(payload.question) &&
    Array.isArray(payload.facts) &&
    payload.facts.every(isFact),
  TASK_UPDATED: (payload, scenario) => isTask(payload.task, scenario),
  COMMAND_REJECTED: (payload) => isString(payload.commandType) && isString(payload.reason),
};

/** Validate unknown data (such as JSON from a socket) as a complete KakiEvent for the scenario. */
export function isKakiEvent(value: unknown, scenario: Scenario): value is KakiEvent {
  if (!isObject(value)) return false;
  const { type, payload, audience } = value;
  if (!isKnownEventType(type) || !isObject(payload) || !isAudience(audience, scenario)) return false;
  if (!PAYLOAD_CHECKS[type](payload, scenario)) return false;
  if ((type === 'NUDGE' || type === 'FACT_FOUND') && audience.kind !== 'role') return false;
  return true;
}
