import { describe, expect, it } from 'vitest';
import { isKakiEvent } from '../src/events';
import { testScenario } from './fixtures';

const task = {
  id: 'task-1',
  title: 'Fix the oven',
  context: 'The oven trips the fuse after ten minutes.',
  suggestedAssignee: 'chef',
  assignee: 'chef',
  actionKind: 'gitea_issue',
  status: 'DRAFT_READY',
  draft: { target: 'kitchen/oven', subject: 'Fix the oven', body: 'Please fix it.' },
  updatedAt: '2026-10-23T09:00:00.000Z',
};

const nudge = {
  type: 'NUDGE',
  audience: { kind: 'role', role: 'chef' },
  payload: { text: 'Prep starts in one minute.' },
};

const factFound = {
  type: 'FACT_FOUND',
  audience: { kind: 'role', role: 'chef' },
  payload: {
    questionId: 'q-oven',
    question: 'When was the oven last serviced?',
    facts: [{ text: 'Last serviced in May.', source: 'Service log', date: '2026-05-02' }],
  },
};

const recordUpdate = {
  type: 'MEETING_RECORD_UPDATED',
  audience: { kind: 'all' },
  payload: {
    agendaIndex: 0,
    openQuestions: [{ id: 'q-oven', text: 'When was the oven last serviced?', forRole: 'chef' }],
    elapsedSeconds: 125,
    speakerTalkSeconds: { chef: 90, cashier: 35 },
  },
};

describe('isKakiEvent', () => {
  it('accepts well-formed events for the scenario', () => {
    expect(isKakiEvent(nudge, testScenario)).toBe(true);
    expect(isKakiEvent(factFound, testScenario)).toBe(true);
    expect(isKakiEvent(recordUpdate, testScenario)).toBe(true);
    expect(
      isKakiEvent(
        {
          type: 'TASK_UPDATED',
          audience: { kind: 'role', role: 'chef' },
          payload: { task },
        },
        testScenario,
      ),
    ).toBe(true);
    expect(
      isKakiEvent(
        { type: 'COMMAND_REJECTED', audience: { kind: 'screen' }, payload: { commandType: 'SYNC_TASK', reason: 'Nothing to sync' } },
        testScenario,
      ),
    ).toBe(true);
    expect(
      isKakiEvent(
        { type: 'TRANSCRIPT_CHUNK', audience: { kind: 'all' }, payload: { speaker: 'Ada', text: 'Hello', timestamp: '00:01' } },
        testScenario,
      ),
    ).toBe(true);
    expect(
      isKakiEvent(
        { type: 'HOST_SPEECH_TRIGGERED', audience: { kind: 'screen' }, payload: { kind: 'OPENING', text: 'Welcome' } },
        testScenario,
      ),
    ).toBe(true);
  });

  it('requires NUDGE and FACT_FOUND to use a role audience', () => {
    expect(isKakiEvent({ ...nudge, audience: { kind: 'screen' } }, testScenario)).toBe(false);
    expect(isKakiEvent({ ...nudge, audience: { kind: 'all' } }, testScenario)).toBe(false);
    expect(isKakiEvent({ ...factFound, audience: { kind: 'screen' } }, testScenario)).toBe(false);
    expect(isKakiEvent({ ...factFound, audience: { kind: 'all' } }, testScenario)).toBe(false);
  });

  it('rejects unknown roles in every place', () => {
    expect(isKakiEvent({ ...nudge, audience: { kind: 'role', role: 'waiter' } }, testScenario)).toBe(false);
    expect(
      isKakiEvent(
        { ...recordUpdate, payload: { ...recordUpdate.payload, speakerTalkSeconds: { waiter: 10 } } },
        testScenario,
      ),
    ).toBe(false);
    expect(
      isKakiEvent(
        {
          ...recordUpdate,
          payload: {
            ...recordUpdate.payload,
            openQuestions: [{ id: 'q', text: 'Question', forRole: 'waiter' }],
          },
        },
        testScenario,
      ),
    ).toBe(false);
    expect(
      isKakiEvent(
        {
          type: 'TASK_UPDATED',
          audience: { kind: 'screen' },
          payload: { task: { ...task, suggestedAssignee: 'waiter' } },
        },
        testScenario,
      ),
    ).toBe(false);
    expect(
      isKakiEvent(
        {
          type: 'TASK_UPDATED',
          audience: { kind: 'screen' },
          payload: { task: { ...task, assignee: 'waiter' } },
        },
        testScenario,
      ),
    ).toBe(false);
  });

  it('accepts the optional notetaker status and quiet roles on a record update, and checks them', () => {
    const withExtras = (extras: Record<string, unknown>) => ({
      ...recordUpdate,
      payload: { ...recordUpdate.payload, ...extras },
    });

    expect(isKakiEvent(withExtras({ notetakerStatus: 'stale', quietRoles: ['cashier'] }), testScenario)).toBe(true);
    expect(isKakiEvent(withExtras({ notetakerStatus: 'off', quietRoles: [] }), testScenario)).toBe(true);
    expect(isKakiEvent(withExtras({ notetakerStatus: 'asleep' }), testScenario)).toBe(false);
    expect(isKakiEvent(withExtras({ quietRoles: ['waiter'] }), testScenario)).toBe(false);
    expect(isKakiEvent(withExtras({ quietRoles: 'cashier' }), testScenario)).toBe(false);
  });

  it('rejects malformed tasks', () => {
    const taskEvent = { type: 'TASK_UPDATED', audience: { kind: 'screen' }, payload: { task } };
    expect(isKakiEvent({ ...taskEvent, payload: { task: { ...task, status: 'LOST' } } }, testScenario)).toBe(false);
    expect(isKakiEvent({ ...taskEvent, payload: { task: { ...task, actionKind: 'carrier_pigeon' } } }, testScenario)).toBe(false);
    expect(isKakiEvent({ ...taskEvent, payload: { task: { ...task, draft: { target: 'x' } } } }, testScenario)).toBe(false);
    expect(isKakiEvent({ ...taskEvent, payload: { task: { ...task, updatedAt: undefined } } }, testScenario)).toBe(false);
  });

  it('rejects old event types and malformed payloads', () => {
    expect(isKakiEvent({ ...nudge, type: 'TASK_DISPATCHED' }, testScenario)).toBe(false);
    expect(isKakiEvent({ ...nudge, type: 'ACTION_STATUS_CHANGED' }, testScenario)).toBe(false);
    expect(isKakiEvent({ ...nudge, payload: {} }, testScenario)).toBe(false);
    expect(isKakiEvent({ ...factFound, payload: { questionId: 'q', question: 'Q' } }, testScenario)).toBe(false);
    expect(isKakiEvent({ type: 'COMMAND_REJECTED', audience: { kind: 'screen' }, payload: { commandType: 'SYNC_TASK' } }, testScenario)).toBe(false);
    expect(isKakiEvent(null, testScenario)).toBe(false);
    expect(isKakiEvent('NUDGE', testScenario)).toBe(false);
  });
});
