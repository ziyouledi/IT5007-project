import { randomUUID } from 'node:crypto';
import {
  canTransition,
  isActionDraft,
  isAssignmentEvidence,
  isRoleIn,
  isSuggestInput,
  isTask,
  isTaskPurpose,
  type ActionDraft,
  type AssignmentEvidence,
  type KakiCommand,
  type KakiEvent,
  type Role,
  type Scenario,
  type SuggestInput,
  type Task,
  type TaskPurpose,
  type TaskStatus,
} from '@kaki/shared';
import type { ClientAudience } from '../core/audience';
import { CommandError, type Hub } from '../core/hub';

type TaskPatch = Partial<Pick<Task, 'assignee' | 'declinedBy' | 'mode' | 'draft' | 'artifactUrl' | 'error'>>;

/** Shown on a task that was mid-action when the server stopped; its owner can Retry. */
export const INTERRUPTED_TASK_ERROR =
  'Kaki restarted while this was running. It may already have gone through: check before tapping Retry.';

/** Shown on a card whose assignee could not be reached or gave no readable answer. */
export const TASK_UNDECIDED_ERROR = 'AI colleague could not decide';

/** The single owner of task state; every other module changes tasks through it. */
export interface TaskStore {
  /**
   * Suggest a task. `assignmentEvidence` and `sourceSeconds` are separate trusted arguments, never part of the public
   * SuggestInput body, so an API caller cannot forge a commitment or a source time and have the assignee's responder
   * auto-accept it.
   */
  suggest(input: SuggestInput, assignmentEvidence?: AssignmentEvidence, sourceSeconds?: number): Task;
  /**
   * Create a task for a server-owned milestone. This is not part of any request body: only trusted server code
   * (the end-of-meeting minutes in the wiki module) may stamp a purpose.
   */
  suggestWithPurpose(input: SuggestInput, purpose: TaskPurpose): Task;
  /** Replace an early suggestion with the visitor's final wording before dispatch; its purpose never changes. */
  reviseSuggested(id: string, input: SuggestInput, sourceSeconds?: number): Task;
  supersede(id: string): Task;
  get(id: string): Task | undefined;
  list(): Task[];
  transition(id: string, to: TaskStatus, patch?: TaskPatch): Task;
  handleCommand(command: KakiCommand, sender: ClientAudience): void;
  /** Forget every task (a new meeting starts); pages are told by the MEETING_RESET event. */
  reset(): void;
  /** Every task now, for saving across a restart. */
  snapshot(): Task[];
  /**
   * Take up the tasks saved before a restart. A task Kaki was working on (running an action or still drafting one)
   * becomes FAILED and marked interrupted, because whatever was writing cannot have finished: its owner sees Retry
   * and is never left waiting, and nothing retries it automatically.
   */
  restore(tasks: readonly Task[]): void;
  /**
   * React to task changes here, never via hub TASK_UPDATED: each change goes out once
   * for the screen and again for the assignee. Called once per change, after the hub
   * publishes. Do slow work asynchronously and call transition when done.
   */
  onChange(handler: (task: Task, previous: TaskStatus | undefined) => void): () => void;
}

function taskUpdated(task: Task, audience: KakiEvent['audience']): KakiEvent {
  return { type: 'TASK_UPDATED', audience, payload: { task } };
}

/** Copy evidence so a caller cannot mutate the stored task through the object it passed in, or vice versa. */
function copyAssignmentEvidence(evidence: AssignmentEvidence): AssignmentEvidence {
  return {
    speaker: evidence.speaker,
    quote: evidence.quote,
    scope: {
      title: evidence.scope.title,
      context: evidence.scope.context,
      ...(evidence.scope.actionKind === undefined ? {} : { actionKind: evidence.scope.actionKind }),
    },
  };
}

function assertPatch(patch: TaskPatch, scenario: Scenario): void {
  if (patch.assignee !== undefined && !isRoleIn(scenario, patch.assignee)) {
    throw new CommandError('Unknown assignee role');
  }
  if (patch.mode !== undefined && patch.mode !== 'ACTION_AGENT' && patch.mode !== 'MANUAL') {
    throw new CommandError('Unknown task mode');
  }
  if (patch.draft !== undefined && !isActionDraft(patch.draft)) {
    throw new CommandError('Draft must have a target, subject and body');
  }
  if (patch.artifactUrl !== undefined && typeof patch.artifactUrl !== 'string') {
    throw new CommandError('Artifact URL must be text');
  }
  if (patch.error !== undefined && typeof patch.error !== 'string') {
    throw new CommandError('Error must be text');
  }
}

/** True when Kaki itself was mid-work: running the action, or still drafting it for the assignee. */
function wasBeingWorkedOn(task: Task): boolean {
  return task.status === 'RUNNING' || (task.status === 'CLAIMED' && task.mode === 'ACTION_AGENT');
}

/**
 * Create the task store that routes task changes through the hub. The scenario is read through a
 * getter when the meeting can replace it (a Start commit or a reset); a plain value is accepted for
 * standalone uses such as the notetaker's evaluation harness.
 */
export function createTaskStore({
  hub,
  scenario,
}: {
  hub: Hub;
  scenario: Scenario | (() => Scenario);
}): TaskStore {
  const active = typeof scenario === 'function' ? scenario : () => scenario;
  const tasks = new Map<string, Task>();
  const changeHandlers = new Set<(task: Task, previous: TaskStatus | undefined) => void>();

  function notifyChange(task: Task, previous: TaskStatus | undefined): void {
    for (const handler of changeHandlers) {
      try {
        handler(task, previous);
      } catch (error) {
        console.error('kaki tasks: a change handler failed', error);
      }
    }
  }

  function publishTask(task: Task, previousAssignee?: Role): void {
    hub.publish(taskUpdated(task, { kind: 'screen' }), { retainKey: `task:${task.id}` });
    // Whoever had the task until now must hear that it is no longer theirs (declined or reassigned).
    for (const role of new Set([previousAssignee, task.assignee])) {
      if (role === undefined) continue;
      hub.publish(taskUpdated(task, { kind: 'role', role }), { retainKey: `task:${task.id}:${role}` });
    }
  }

  function requireTask(id: string): Task {
    const task = tasks.get(id);
    if (task === undefined) throw new CommandError('Task not found');
    return task;
  }

  function transition(id: string, to: TaskStatus, patch: TaskPatch = {}): Task {
    const current = requireTask(id);
    if (!canTransition(current.status, to)) {
      throw new CommandError(`Cannot move a task from ${current.status} to ${to}`);
    }
    assertPatch(patch, active());

    const { error, ...rest } = patch;
    const draft: ActionDraft | undefined = patch.draft === undefined ? current.draft : { ...patch.draft };
    const next: Task = {
      ...current,
      ...rest,
      ...(current.assignmentEvidence === undefined
        ? {}
        : { assignmentEvidence: copyAssignmentEvidence(current.assignmentEvidence) }),
      draft,
      status: to,
      updatedAt: new Date().toISOString(),
    };
    // A restart interruption lasts only until the task moves again (for example when its owner taps Retry).
    delete next.interrupted;
    // Any transition may carry its own visible reason (a failed action, or an undecided card); moving on clears it.
    if (error !== undefined) {
      next.error = error;
    } else {
      delete next.error;
    }
    tasks.set(id, next);
    publishTask(next, current.assignee);
    notifyChange(next, current.status);
    return next;
  }

  function isSourceSeconds(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function createTask(
    input: SuggestInput,
    purpose: TaskPurpose | undefined,
    assignmentEvidence: AssignmentEvidence | undefined,
    sourceSeconds: number | undefined,
  ): Task {
    if (!isSuggestInput(input, active())) throw new CommandError('Invalid task suggestion');
    if (purpose !== undefined && !isTaskPurpose(purpose)) throw new CommandError('Invalid task purpose');
    if (assignmentEvidence !== undefined && !isAssignmentEvidence(assignmentEvidence)) {
      throw new CommandError('Invalid assignment evidence');
    }
    if (sourceSeconds !== undefined && !isSourceSeconds(sourceSeconds)) {
      throw new CommandError('Invalid source time');
    }

    const task: Task = {
      id: `task-${randomUUID()}`,
      title: input.title,
      context: input.context,
      suggestedAssignee: input.suggestedAssignee,
      actionKind: input.actionKind,
      ...(purpose === undefined ? {} : { purpose }),
      ...(input.decisionSource === undefined ? {} : { decisionSource: input.decisionSource }),
      ...(input.agendaItemTitle === undefined ? {} : { agendaItemTitle: input.agendaItemTitle }),
      ...(sourceSeconds === undefined ? {} : { sourceSeconds }),
      ...(assignmentEvidence === undefined ? {} : { assignmentEvidence: copyAssignmentEvidence(assignmentEvidence) }),
      status: 'SUGGESTED',
      updatedAt: new Date().toISOString(),
    };
    tasks.set(task.id, task);
    publishTask(task);
    notifyChange(task, undefined);
    return task;
  }

  function suggest(input: SuggestInput, assignmentEvidence?: AssignmentEvidence, sourceSeconds?: number): Task {
    return createTask(input, undefined, assignmentEvidence, sourceSeconds);
  }

  function suggestWithPurpose(input: SuggestInput, purpose: TaskPurpose): Task {
    return createTask(input, purpose, undefined, undefined);
  }

  function reviseSuggested(id: string, input: SuggestInput, sourceSeconds?: number): Task {
    if (!isSuggestInput(input, active())) throw new CommandError('Invalid task suggestion');
    if (sourceSeconds !== undefined && !isSourceSeconds(sourceSeconds)) {
      throw new CommandError('Invalid source time');
    }
    const current = requireTask(id);
    if (current.status !== 'SUGGESTED') throw new CommandError('Only a suggested task can be revised');
    // Evidence for the old scope cannot authorise a changed deliverable.
    const { assignmentEvidence: _oldEvidence, ...base } = current;
    // `cardId` names the request's target; it is not part of the stored card.
    const { cardId: _cardId, ...revision } = input;
    // Where the card came from is fixed once known: a retried settlement must not move it later in the meeting.
    const source = current.sourceSeconds ?? sourceSeconds;
    // A revision may change the work, never the server-owned purpose.
    const revised: Task = {
      ...base,
      ...revision,
      ...(source === undefined ? {} : { sourceSeconds: source }),
      updatedAt: new Date().toISOString(),
    };
    tasks.set(id, revised);
    publishTask(revised);
    notifyChange(revised, current.status);
    return revised;
  }

  function requireScreen(sender: ClientAudience): void {
    if (sender.kind !== 'screen') throw new CommandError('Only the shared screen can do that');
  }

  function requireAssignee(task: Task, sender: ClientAudience): void {
    if (task.assignee === undefined) throw new CommandError('Task has no assignee');
    if (sender.kind !== 'role' || sender.role !== task.assignee) {
      throw new CommandError('Only the assigned role can do that');
    }
  }

  function handleCommand(command: KakiCommand, sender: ClientAudience): void {
    switch (command.type) {
      case 'DISPATCH_TASK':
        requireScreen(sender);
        transition(command.taskId, 'DISPATCHED', { assignee: command.assignee });
        return;
      case 'DISMISS_TASK':
        requireScreen(sender);
        transition(command.taskId, 'DISMISSED');
        return;
      case 'DECLINE_TASK': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        // Back to the shared screen's list with nobody assigned, so a person can offer it to someone else.
        transition(command.taskId, 'SUGGESTED', {
          assignee: undefined,
          declinedBy: [...new Set([...(task.declinedBy ?? []), task.assignee as Role])],
        });
        return;
      }
      case 'RETURN_TASK_UNDECIDED': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        // Back to the shared screen without counting as a decline, so a host can offer it again or dismiss it.
        transition(command.taskId, 'SUGGESTED', {
          assignee: undefined,
          error: TASK_UNDECIDED_ERROR,
        });
        return;
      }
      case 'CLAIM_TASK': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        if (command.mode === 'ACTION_AGENT' && task.actionKind === undefined) {
          throw new CommandError('This task has no action to run; do it manually');
        }
        transition(command.taskId, 'CLAIMED', { mode: command.mode });
        return;
      }
      case 'APPROVE_ACTION': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        transition(command.taskId, 'RUNNING', { draft: command.draft });
        return;
      }
      case 'RETRY_ACTION': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        const patch = command.draft === undefined ? {} : { draft: command.draft };
        // Without a draft there is nothing to post, so claim again and let the action re-draft.
        const hasDraft = command.draft !== undefined || task.draft !== undefined;
        transition(command.taskId, hasDraft ? 'RUNNING' : 'CLAIMED', patch);
        return;
      }
      case 'MARK_DONE': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        if (task.mode !== 'MANUAL') throw new CommandError('Only a manual task can be marked done');
        transition(command.taskId, 'COMPLETED');
        return;
      }
      case 'SYNC_TASK': {
        const task = requireTask(command.taskId);
        requireAssignee(task, sender);
        transition(command.taskId, 'SYNCED');
        return;
      }
      case 'END_MEETING':
      case 'LEAVE_MEETING':
      case 'NEW_MEETING':
      case 'NEXT_AGENDA_ITEM':
      case 'SET_HOST_MODE':
        return; // the meeting module owns these
    }
  }

  return {
    suggest,
    suggestWithPurpose,
    reviseSuggested,
    supersede: (id) => transition(id, 'SUPERSEDED'),
    get: (id) => tasks.get(id),
    list: () => [...tasks.values()],
    transition,
    handleCommand,
    reset() {
      tasks.clear();
    },
    snapshot() {
      return [...tasks.values()].map((task) => ({
        ...task,
        ...(task.declinedBy === undefined ? {} : { declinedBy: [...task.declinedBy] }),
        ...(task.draft === undefined ? {} : { draft: { ...task.draft } }),
        ...(task.assignmentEvidence === undefined
          ? {}
          : { assignmentEvidence: copyAssignmentEvidence(task.assignmentEvidence) }),
      }));
    },
    restore(saved) {
      tasks.clear();
      for (const task of saved) {
        if (!isTask(task, active())) {
          const id = String((task as unknown as { id?: unknown }).id);
          throw new Error(
            `Saved task "${id}" does not belong to this scenario. Run \`npm run meeting:reset\` to discard it.`,
          );
        }
        const next: Task = wasBeingWorkedOn(task)
          ? {
              ...task,
              status: 'FAILED',
              error: INTERRUPTED_TASK_ERROR,
              interrupted: true,
              updatedAt: new Date().toISOString(),
            }
          : { ...task };
        tasks.set(next.id, next);
        publishTask(next);
      }
    },
    onChange: (handler) => {
      changeHandlers.add(handler);
      return () => {
        changeHandlers.delete(handler);
      };
    },
  };
}
