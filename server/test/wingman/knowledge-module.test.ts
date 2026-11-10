import { describe, expect, it, vi } from 'vitest';
import type { Fact, KakiEvent, Scenario, SearchCompanyData } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import type { TaskStore } from '../../src/tasks';
import { createKnowledgeModule } from '../../src/wingman/knowledge/module';
import { settle, waitFor } from '../helpers';

const scenario: Scenario = {
  id: 'test-kitchen',
  organisation: 'Test Kitchen',
  meetingTitle: 'Lunch service',
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
    { id: 'game_designer', label: 'Game Designer' },
    { id: 'producer', label: 'Producer' },
  ],
  attendees: [],
  agenda: [{ title: 'Prep', minutes: 5, ownerRole: 'chef', decision: 'Do we prep early?' }],
};

const fact: Fact = { text: 'Level 5 has the quit spike.', source: 'postgres', date: '2026-11-10' };

function fakeHub(): {
  hub: Hub;
  published: KakiEvent[];
  retainKeys: (string | undefined)[];
  subscribed: () => number;
  emit: (event: KakiEvent) => void;
} {
  const handlers = new Set<(event: KakiEvent) => void>();
  const published: KakiEvent[] = [];
  const retainKeys: (string | undefined)[] = [];
  const hub: Hub = {
    publish(event, options) {
      published.push(event);
      retainKeys.push(options?.retainKey);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onCommand() {
      throw new Error('not used');
    },
    clearRetained() {},
    close() {
      handlers.clear();
    },
  };
  return {
    hub,
    published,
    retainKeys,
    subscribed: () => handlers.size,
    emit: (event) => {
      for (const handler of handlers) handler(event);
    },
  };
}

function recordUpdate(
  questionId = 'q-quit',
  forRole: 'game_designer' | 'producer' | null = 'game_designer',
  agendaIndex = 0,
): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: {
      agendaIndex,
      openQuestions: [{ id: questionId, text: 'Where do players quit?', ...(forRole === null ? {} : { forRole }) }],
      elapsedSeconds: 1,
      speakerTalkSeconds: {},
    },
  };
}

function recordUpdateWithNoQuestions(): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: {
      agendaIndex: 0,
      openQuestions: [],
      elapsedSeconds: 1,
      speakerTalkSeconds: {},
    },
  };
}

function start(search: SearchCompanyData, hub: Hub): () => void {
  const module = createKnowledgeModule({ search, env: {} });
  const stop = module.start({ hub, tasks: {} as TaskStore, scenario });
  if (typeof stop !== 'function') throw new Error('Expected a cleanup function');
  return stop;
}

describe('knowledge module', () => {
  it('publishes one private card for a question, only to its role', async () => {
    const calls: string[] = [];
    const search: SearchCompanyData = async (question, role) => {
      calls.push(`${question}:${role}`);
      return [fact];
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate());
      fake.emit(recordUpdate());
      await waitFor(() => fake.published.length > 0, 'the fact card');
      await settle();

      expect(calls).toEqual(['Where do players quit?:game_designer']);
      expect(fake.published).toEqual([
        {
          type: 'FACT_FOUND',
          audience: { kind: 'role', role: 'game_designer' },
          payload: { questionId: 'q-quit', question: 'Where do players quit?', facts: [fact], agendaIndex: 0 },
        },
      ]);
      expect(fake.retainKeys).toEqual(['fact:q-quit']);
    } finally {
      stop();
    }
  });

  it('tags the fact card with the agenda item the question belongs to', async () => {
    const fake = fakeHub();
    const stop = start(async () => [fact], fake.hub);

    try {
      fake.emit(recordUpdate('q-level-5', 'game_designer', 1));
      await waitFor(() => fake.published.length > 0, 'the fact card');

      expect(fake.published[0]).toMatchObject({
        type: 'FACT_FOUND',
        payload: { questionId: 'q-level-5', agendaIndex: 1 },
      });
    } finally {
      stop();
    }
  });

  it('does not search for a question raised on an earlier agenda item', async () => {
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit({
        type: 'MEETING_RECORD_UPDATED',
        audience: { kind: 'all' },
        payload: {
          agendaIndex: 1,
          openQuestions: [
            { id: 'q-old', text: 'Where do players quit?', forRole: 'game_designer', agendaIndex: 0 },
            { id: 'q-new', text: 'Who owns the build?', forRole: 'producer', agendaIndex: 1 },
          ],
          elapsedSeconds: 1,
          speakerTalkSeconds: {},
        },
      });
      await waitFor(() => fake.published.length > 0, 'the fact card');
      await settle();
      expect(search.mock.calls).toEqual([['Who owns the build?', 'producer']]);
    } finally {
      stop();
    }
  });

  it('skips questions without a role and warns once', async () => {
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate('q-orphan', null));
      fake.emit(recordUpdate('q-orphan', null));
      await settle();
      expect(search).not.toHaveBeenCalled();
      expect(fake.published).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('q-orphan'));
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it('logs loudly and sends no card when the search fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search: SearchCompanyData = async () => {
      throw new Error('gateway down');
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate());
      await waitFor(() => error.mock.calls.length > 0, 'the loud error');
      expect(fake.published).toEqual([]);
      expect(error.mock.calls[0]?.[0]).toContain('q-quit');
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('retries a failed search on the next record, then gives up after three tries', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const search: SearchCompanyData = async () => {
      calls += 1;
      throw new Error('gateway down');
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      for (let i = 0; i < 5; i += 1) {
        fake.emit(recordUpdate());
        await settle();
      }
      expect(calls).toBe(3);
      expect(fake.published).toEqual([]);
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('sends the card once when a retry succeeds', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const search: SearchCompanyData = async () => {
      calls += 1;
      if (calls === 1) throw new Error('gateway down');
      return [fact];
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      for (let i = 0; i < 3; i += 1) {
        fake.emit(recordUpdate());
        await settle();
      }
      expect(calls).toBe(2);
      expect(fake.published).toHaveLength(1);
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('logs loudly and sends no card when the search finds no facts', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeHub();
    const stop = start(async () => [], fake.hub);

    try {
      fake.emit(recordUpdate());
      await waitFor(() => error.mock.calls.length > 0, 'the empty-result error');
      expect(fake.published).toEqual([]);
      expect(error.mock.calls[0]?.[0]).toContain('no company facts');
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('stays disabled and explains why when config is missing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fake = fakeHub();
    const module = createKnowledgeModule({ env: {} });

    try {
      const stop = module.start({ hub: fake.hub, tasks: {} as TaskStore, scenario });
      expect(stop).toBeUndefined();
      expect(fake.subscribed()).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('company search disabled'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('KAKI_LLM_BASE_URL'));
    } finally {
      log.mockRestore();
    }
  });

  it('does not search company records proactively when an agenda item has no open question', async () => {
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdateWithNoQuestions());
      await settle();
      fake.emit(recordUpdateWithNoQuestions());
      await settle();

      expect(search).not.toHaveBeenCalled();
      expect(fake.published).toEqual([]);
    } finally {
      stop();
    }
  });

  it('still searches and publishes a fact for a real open question', async () => {
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdateWithNoQuestions());
      await settle();
      expect(search).not.toHaveBeenCalled();

      fake.emit(recordUpdate());
      await waitFor(() => fake.published.length === 1, 'the open-question fact card');

      expect(search).toHaveBeenCalledWith('Where do players quit?', 'game_designer');
      expect(fake.published[0]).toMatchObject({
        type: 'FACT_FOUND',
        payload: { questionId: 'q-quit', question: 'Where do players quit?', facts: [fact], agendaIndex: 0 },
      });
    } finally {
      stop();
    }
  });

  it('clears settled questions on MEETING_RESET so a new meeting can look up q-1 again', async () => {
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate('q-1'));
      await waitFor(() => fake.published.length === 1, 'first meeting fact card');
      fake.emit({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: {} });
      fake.emit(recordUpdate('q-1'));
      await waitFor(() => fake.published.length === 2, 'second meeting fact card after reset');
      expect(search).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
});
