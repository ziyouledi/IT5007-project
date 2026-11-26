import { parseJsonReply, type LlmClient } from '../services/llm';
import { isAssignmentEvidence, speakerName, type ActionDraft, type KakiCommand, type KakiEvent, type NpcProfile, type Role, type Scenario, type Task } from '@kaki/shared';
import { isHypotheticalProposal, isSelfVolunteerCommitment } from '../host/notetakerTasks';

/** One completed, actually heard transcript line on the topic the task came from. */
export interface DecisionLine {
  speaker: string;
  text: string;
  /** The agenda item it was heard on; a line without one cannot ground a prior commitment. */
  agendaItemTitle?: string;
}

/** What the responder needs from the rest of the NPC process; each is replaced in tests. */
interface TaskResponderPorts {
  scenario: Scenario;
  llm: Pick<LlmClient, 'complete'>;
  /** True when this attendee is voiced by the AI right now (a person may have taken the seat). */
  plays(attendee: string): boolean;
  /**
   * The old topic-wide regex flag. It is only logged now: a line on the topic is never proof that this exact task
   * was promised, so the model judges the task against the numbered transcript lines instead.
   */
  volunteeredOnTopic?(attendee: string): boolean;
  /** Completed, actually heard lines on the current topic, oldest first. A cut or queued line is not included. */
  completedLinesOnTopic?(): DecisionLine[];
  /** The attendee says the line aloud; `onDone` runs once it has finished, with whether the room heard it. */
  say(attendee: string, text: string, onDone: (spoken: boolean) => void): void;
  /** Send a command as the phone of `role` would. */
  send(role: Role, command: KakiCommand): void;
  log?(message: string): void;
  /** How long they "read" a draft before approving it; a person would not approve in the same instant. */
  approveDelayMs?: number;
  /** The deadline for one decision attempt; a retry gets its own. */
  decisionDeadlineMs?: number;
  /** When true, still claim and draft tasks, but never auto-approve or retry so nothing is sent. */
  draftOnly?: boolean;
}

/** Default pause before an AI attendee approves a draft. */
export const DEFAULT_APPROVE_DELAY_MS = 6000;
/** Default deadline for one decision call, so two failed attempts cannot leave the card waiting forever. */
const DEFAULT_DECISION_DEADLINE_MS = 12_000;
/** How many times the decision is asked for: once, then one retry. */
const DECISION_ATTEMPTS = 2;
/** The most transcript lines put in front of the decision, so a long topic cannot grow the prompt without bound. */
const MAX_DECISION_LINES = 40;

interface Decision {
  accept: boolean;
  line: string | null;
  priorCommitment: boolean;
  evidenceIndex: number | null;
  /** A spoken line the model gave alongside a prior-commitment claim, kept in case the claim does not check out. */
  spoken?: { accept: boolean; line: string };
}

function profileFor(scenario: Scenario, role: Role): { npc: NpcProfile; attendee: string } | undefined {
  const attendee = scenario.attendees.find((candidate) => candidate.role === role);
  const npc = (scenario.npcs ?? []).find((candidate) => candidate.attendee === attendee?.name);
  return attendee === undefined || npc === undefined ? undefined : { npc, attendee: attendee.name };
}

function baseSpeakerName(speaker: string): string {
  return speakerName(speaker).toLowerCase();
}

/**
 * True only when the recorded evidence is the current assignee's own grounded commitment to exactly this task.
 * A changed title, context or action is a different task, and a request, delegation, question or hypothetical
 * (or evidence about someone else) never grants acceptance authority.
 */
function isTrustedCommitment(task: Task, attendee: string, scenario: Scenario): boolean {
  const evidence = task.assignmentEvidence;
  if (evidence === undefined || !isAssignmentEvidence(evidence)) return false;
  if (baseSpeakerName(evidence.speaker) !== baseSpeakerName(attendee)) return false;
  if (!isSelfVolunteerCommitment(evidence.quote, scenario, evidence.speaker)) return false;
  if (isHypotheticalProposal(evidence.quote)) return false;
  const { scope } = evidence;
  return scope.title === task.title && scope.context === task.context && scope.actionKind === task.actionKind;
}

/**
 * The model's answer, or undefined when it is not usable. The ordinary decision needs a boolean and a nonempty
 * spoken line. An extended decision also says whether the attendee already promised this exact task; `true` needs
 * a line index and permits a silent claim, while `false` needs the ordinary line.
 */
export function parseDecision(text: string, requirePriorCommitment = false): Decision | undefined {
  let json: unknown;
  try {
    json = parseJsonReply(text);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const { accept, line, priorCommitment, evidenceIndex } = json as {
    accept?: unknown;
    line?: unknown;
    priorCommitment?: unknown;
    evidenceIndex?: unknown;
  };
  if (requirePriorCommitment && typeof priorCommitment !== 'boolean') return undefined;
  if (priorCommitment === true) {
    if (!Number.isInteger(evidenceIndex) || (evidenceIndex as number) < 1) return undefined;
    const spoken = typeof accept === 'boolean' && typeof line === 'string' && line.trim() !== ''
      ? { spoken: { accept, line: line.trim() } }
      : {};
    return { accept: true, line: null, priorCommitment: true, evidenceIndex: evidenceIndex as number, ...spoken };
  }
  if (priorCommitment !== undefined && typeof priorCommitment !== 'boolean') return undefined;
  if (typeof accept !== 'boolean' || typeof line !== 'string' || line.trim() === '') return undefined;
  return { accept, line: line.trim(), priorCommitment: false, evidenceIndex: null };
}

/**
 * An AI attendee has no phone, so this does what the phone would. When a task is dispatched to their role the
 * character decides, in character, whether to take it, says so aloud, and only then sends Accept or Decline,
 * so the shared screen follows their words. After an accepted task's draft is ready they approve it.
 */
export function createTaskResponder(ports: TaskResponderPorts): { handle(event: KakiEvent): void } {
  const { scenario, llm, log } = ports;
  const answered = new Set<string>();
  const approved = new Set<string>();
  const retried = new Set<string>();

  /**
   * Check a prior-commitment answer against the exact line it points at: the line must exist on this topic, be
   * the attendee's own, and still describe this same task. Anything else is unreadable, never an acceptance.
   */
  function priorCommitmentLine(
    decision: Decision,
    task: Task,
    attendee: string,
    lines: DecisionLine[],
  ): DecisionLine | undefined {
    if (decision.evidenceIndex === null) return undefined;
    // The prompt numbers the lines from 1, so the model's line number is not a zero-based array index.
    const line = lines[decision.evidenceIndex - 1];
    if (line === undefined) return undefined;
    if (baseSpeakerName(line.speaker) !== baseSpeakerName(attendee)) return undefined;
    if (line.agendaItemTitle === undefined) return undefined;
    if (task.agendaItemTitle !== undefined && line.agendaItemTitle !== task.agendaItemTitle) return undefined;
    const evidence = task.assignmentEvidence;
    if (evidence !== undefined) {
      if (baseSpeakerName(evidence.speaker) !== baseSpeakerName(attendee)) return undefined;
      const { scope } = evidence;
      if (scope.title !== task.title || scope.context !== task.context || scope.actionKind !== task.actionKind) {
        return undefined;
      }
      if (evidence.quote.trim() !== line.text.trim()) return undefined;
    }
    // The old lexical check is a backstop for the log only; the model's meaning-based answer is what counts.
    if (!isSelfVolunteerCommitment(line.text, scenario, line.speaker)) {
      log?.(`the model saw a prior commitment in a line the lexical check would not: "${line.text}"`);
    }
    return line;
  }

  async function decide(
    task: Task,
    npc: NpcProfile,
    role: Role,
    lines: DecisionLine[],
  ): Promise<Decision | undefined> {
    const fact = scenario.agenda.find((item) => item.title === task.agendaItemTitle)?.seatFacts?.[role];
    const recent = lines.slice(-MAX_DECISION_LINES);
    const numbered = recent.map((line, index) => `${index + 1}. ${line.speaker}: ${line.text}`);
    const system = [
      `You are ${npc.attendee} in a work meeting. ${npc.personality}`,
      `What you want: ${npc.agenda}`,
      npc.concerns.length > 0 ? `You worry about: ${npc.concerns.join('; ')}.` : '',
      fact === undefined ? '' : `Things you know: ${fact}`,
      'The meeting host has just handed you a task. Decide, as this character, whether to take it.',
      'Accept it (`"accept": true`) if it is a follow-up ticket, post, email or note for your role or something your role talked about. Only decline (`"accept": false`) if the task clearly belongs to a completely different role.',
      'Also judge whether you already promised this exact task. `priorCommitment` is true only for this attendee\'s direct, unconditional, unretracted promise to do this exact title, details, and action kind; requests, hypotheticals, and other work are false. `evidenceIndex` is that line\'s number, or null.',
      'Reply with one JSON object: {"priorCommitment": true or false, "evidenceIndex": number or null, "accept": true or false, "line": what you say aloud or null}.',
      'When priorCommitment is true you may set accept to true and line to null. Otherwise give a nonempty spoken line.',
      `When accepting ("accept": true), clearly say you will take the task${fact === undefined ? '' : ', with one brief concrete detail from the things you know above'}. Never invent numbers, facts, drafts or prerequisites. Make a statement, never ask a question. Use plain everyday words, without office-speak.`,
    ]
      .filter((part) => part !== '')
      .join('\n');
    const user = [
      `Task: ${task.title}`,
      `Details: ${task.context}`,
      ...(task.actionKind === undefined ? [] : [`Action: ${task.actionKind}`]),
      'Completed lines on this topic, oldest first (numbered from 1):',
      ...(recent.length === 0 ? ['(none)'] : numbered),
    ].join('\n');
    const requirePriorCommitment = recent.length > 0;
    const deadlineMs = ports.decisionDeadlineMs ?? DEFAULT_DECISION_DEADLINE_MS;
    // Set after a prior-commitment claim that no heard line backs: the retry is told so, and must answer aloud.
    let noPriorPromise = false;

    for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt += 1) {
      try {
        const reply = await llm.complete(
          [
            { role: 'system', content: system },
            {
              role: 'user',
              content: noPriorPromise
                ? `${user}\nYou did not promise this task yourself: someone else handed it to you. Set "priorCommitment" to false and say aloud whether you take it.`
                : user,
            },
          ],
          { json: true, temperature: 0.7, signal: AbortSignal.timeout(deadlineMs) },
        );
        const decision = parseDecision(reply, requirePriorCommitment);
        if (decision === undefined) {
          log?.(`could not read ${npc.attendee}'s answer to "${task.title}" (attempt ${attempt + 1})`);
          continue;
        }
        if (decision.priorCommitment) {
          const line = priorCommitmentLine(decision, task, npc.attendee, recent);
          if (line === undefined) {
            log?.(
              `${npc.attendee}'s prior commitment for "${task.title}" does not match a heard line (attempt ${attempt + 1})`,
            );
            // A task handed over by someone else is never the attendee's own promise. When the model also said what
            // it would say aloud, that ordinary answer still stands; otherwise ask again without the claim.
            if (decision.spoken !== undefined) {
              log?.(`${npc.attendee} answers "${task.title}" aloud instead`);
              return { ...decision.spoken, priorCommitment: false, evidenceIndex: null };
            }
            noPriorPromise = true;
            continue;
          }
          log?.(`${npc.attendee} already promised "${task.title}" in: "${line.text}"`);
        }
        return decision;
      } catch (error) {
        log?.(
          `${npc.attendee}'s answer to "${task.title}" failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return undefined;
  }

  function claimCommand(task: Task): KakiCommand {
    return { type: 'CLAIM_TASK', taskId: task.id, mode: task.actionKind === undefined ? 'MANUAL' : 'ACTION_AGENT' };
  }

  function undecidedCommand(task: Task): KakiCommand {
    return { type: 'RETURN_TASK_UNDECIDED', taskId: task.id };
  }

  async function respond(task: Task, role: Role, who: { npc: NpcProfile; attendee: string }): Promise<void> {
    const lines = ports.completedLinesOnTopic?.() ?? [];
    // The old topic-wide flag never decides anything now; it is kept only so a disagreement is visible in the log.
    if (ports.volunteeredOnTopic?.(who.attendee) === true) {
      log?.(`the old topic-wide volunteer flag saw ${who.attendee}; the exact task is still judged by the model`);
    }
    // The assignee's own grounded commitment to this exact task still holds them to their words without another model call.
    if (isTrustedCommitment(task, who.attendee, scenario)) {
      log?.(`${who.attendee} keeps their own commitment to "${task.title}" without another word`);
      ports.send(role, claimCommand(task));
      return;
    }
    const decision = await decide(task, who.npc, role, lines);
    if (decision === undefined) {
      log?.(`${who.attendee} could not decide "${task.title}" after ${DECISION_ATTEMPTS} attempts; returning it unresolved`);
      ports.send(role, undecidedCommand(task));
      return;
    }
    if (decision.priorCommitment) {
      log?.(`${who.attendee} claims "${task.title}" silently from their own earlier promise`);
      ports.send(role, claimCommand(task));
      return;
    }
    // A prior commitment is the only silent path, so an ordinary decision always has a spoken line.
    const line = decision.line as string;
    log?.(`${who.attendee} ${decision.accept ? 'accepts' : 'declines'} "${task.title}": "${line}"`);
    const command: KakiCommand = decision.accept ? claimCommand(task) : { type: 'DECLINE_TASK', taskId: task.id };
    ports.say(who.attendee, line, (spoken) => {
      if (spoken) {
        ports.send(role, command);
        return;
      }
      // The room did not hear the answer, so the screen must not record an accept or decline nobody heard.
      log?.(`${who.attendee}'s answer to "${task.title}" was not heard; returning it unresolved`);
      ports.send(role, undecidedCommand(task));
    });
  }

  return {
    handle(event) {
      if (event.type !== 'TASK_UPDATED') return;
      const { task } = event.payload;
      if (task.status === 'SUGGESTED') answered.delete(task.id); // offered again after a decline
      const role = task.assignee;
      if (role === undefined) return;
      const who = profileFor(scenario, role);
      if (who === undefined || !ports.plays(who.attendee)) return;

      if (task.status === 'DISPATCHED' && !answered.has(task.id)) {
        answered.add(task.id);
        void respond(task, role, who);
      } else if (!ports.draftOnly && task.status === 'DRAFT_READY' && task.draft !== undefined && !approved.has(task.id)) {
        approved.add(task.id);
        const draft: ActionDraft = task.draft;
        log?.(`${who.attendee} is reading the draft for "${task.title}"`);
        setTimeout(() => ports.send(role, { type: 'APPROVE_ACTION', taskId: task.id, draft }), ports.approveDelayMs ?? DEFAULT_APPROVE_DELAY_MS).unref();
      } else if (
        !ports.draftOnly &&
        task.status === 'FAILED' &&
        task.interrupted !== true &&
        !retried.has(task.id)
      ) {
        retried.add(task.id);
        log?.(`${who.attendee} is retrying failed task "${task.title}"`);
        setTimeout(
          () =>
            ports.send(
              role,
              task.draft === undefined
                ? { type: 'RETRY_ACTION', taskId: task.id }
                : { type: 'RETRY_ACTION', taskId: task.id, draft: task.draft },
            ),
          3000,
        ).unref();
      }
    },
  };
}
