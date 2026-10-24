import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import { createNotetaker, isGrounded, isLikelyDuplicate, parseNotetakerReply } from '../../src/host/notetaker';
import { loadReplay, type ReplayLine } from '../../src/host/replay';
import { createFakeLlm, type ChatMessage } from '../../src/llm';
import { loadScenario } from '../../src/loadScenario';
import { createTaskStore } from '../../src/tasks';

function quietHub(): Hub {
  return {
    publish: (_event: KakiEvent) => {},
    subscribe: () => () => {},
    onCommand: () => {},
    close: () => {},
  };
}

function reply(body: Record<string, unknown>): string {
  return JSON.stringify({ newQuestions: [], answeredQuestionIds: [], newTasks: [], ...body });
}

function userMessage(messages: ChatMessage[]): string {
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

// Just the transcript part of the prompt, so canned replies do not match echoed questions.
function newLines(messages: ChatMessage[]): string {
  return userMessage(messages).split('New transcript lines:')[1] ?? '';
}

let scenario: Scenario;
let replay: ReplayLine[];

beforeAll(async () => {
  scenario = await loadScenario('pixel-kampung');
  replay = await loadReplay(scenario, 'pixel-kampung');
});

// The replay lines between two script times, as a canned transcript slice.
function slice(from: number, to: number): ReplayLine[] {
  return replay.filter((line) => line.at >= from && line.at < to);
}

function setup(respond: Parameters<typeof createFakeLlm>[0], startIndex = 0) {
  const tasks = createTaskStore({ hub: quietHub(), scenario });
  const llm = createFakeLlm(respond);
  let agendaIndex = startIndex;
  const onAgendaIndex = vi.fn((index: number) => {
    agendaIndex = index;
  });
  const notetaker = createNotetaker({ scenario, tasks, llm, agendaIndex: () => agendaIndex, onAgendaIndex });
  const feed = (lines: ReplayLine[]) => lines.forEach((line) => notetaker.addChunk(line));
  return { tasks, llm, notetaker, feed, onAgendaIndex };
}

describe('notetaker on canned Pixel Kampung slices', () => {
  it('suggests the scripted tasks and records the scripted questions', async () => {
    const { tasks, llm, notetaker, feed } = setup((messages) => {
      const text = newLines(messages);
      if (text.includes('ten customers in a row')) {
        return reply({
          newTasks: [
            {
              title: 'File a bug for the crash after ten customers',
              context: 'The game crashes after serving ten customers in a row; blocks the launch build.',
              suggestedAssignee: 'lead_programmer',
              actionKind: 'gitea_issue',
              evidence: 'If you serve ten customers in a row without a break, the game crashes.',
            },
          ],
        });
      }
      if (text.includes('exactly where in level 5')) {
        return reply({
          agendaIndex: 1,
          newQuestions: [{ text: 'Where exactly in level 5 do players quit?', forRole: 'game_designer' }],
        });
      }
      if (text.includes('When does Starfruit need the final build')) {
        return reply({
          agendaIndex: 2,
          newQuestions: [{ text: 'When does Starfruit need the final build?', forRole: 'producer' }],
          newTasks: [
            {
              title: 'Post the launch date in the team channel',
              context: 'Once the final build date is confirmed, tell the team the launch date.',
              suggestedAssignee: 'producer',
              actionKind: 'mattermost_post',
              evidence: "I'll post the launch date in the team channel",
            },
          ],
        });
      }
      if (text.includes('email a streamer')) {
        return reply({
          agendaIndex: 3,
          newTasks: [
            {
              title: 'Email a streamer to play Hawker Heroes on launch day',
              context: 'The launch plan has no live stream yet.',
              suggestedAssignee: 'marketing_lead',
              actionKind: 'email',
              evidence: 'Daniel, can you email a streamer and ask them to play Hawker Heroes on launch day?',
            },
          ],
        });
      }
      return reply({});
    });

    for (const [from, to] of [
      [0, 520],
      [520, 1200],
      [1200, 1650],
      [1650, 2200],
    ] as const) {
      feed(slice(from, to));
      await notetaker.run();
    }

    expect(llm.calls).toHaveLength(4);
    expect(tasks.list().map((task) => [task.suggestedAssignee, task.actionKind, task.status])).toEqual([
      ['lead_programmer', 'gitea_issue', 'SUGGESTED'],
      ['producer', 'mattermost_post', 'SUGGESTED'],
      ['marketing_lead', 'email', 'SUGGESTED'],
    ]);
    expect(notetaker.state().openQuestions).toEqual([
      { id: 'q-1', text: 'Where exactly in level 5 do players quit?', forRole: 'game_designer' },
      { id: 'q-2', text: 'When does Starfruit need the final build?', forRole: 'producer' },
    ]);
    expect(notetaker.state().status).toBe('ok');
  });

  it('tells the LLM who spoke, what is open and what was already suggested', async () => {
    const { llm, notetaker, feed } = setup((_messages, call) =>
      call === 0
        ? reply({
            newQuestions: [{ text: 'When does Starfruit need the final build?' }],
            newTasks: [
              {
                title: 'Fix the crash',
                context: 'Crash after ten customers.',
                suggestedAssignee: 'lead_programmer',
                evidence: 'the game crashes',
              },
            ],
          })
        : reply({}),
    );

    feed(slice(0, 100));
    await notetaker.run();
    feed(slice(100, 200));
    await notetaker.run();

    const [system, user] = llm.calls[1]!;
    expect(system!.content).toContain('lead_programmer: Lead Programmer (Arjun)');
    expect(system!.content).toContain('1. Level 5 difficulty and playtest feedback');
    expect(user!.content).toContain('- q-1: When does Starfruit need the final build?');
    expect(user!.content).toMatch(/- task-[\w-]+: Fix the crash \(owner: lead_programmer\) — Crash after ten customers\./);
    expect(user!.content).toContain('[Wei Ling (Producer)] That blocks the launch build then.');
    // Only lines added since the last pass are sent.
    expect(user!.content).not.toContain('Release candidate two');
  });
});

describe('notetaker record keeping', () => {
  it('does not repeat a task or question the meeting already has, and drops answered questions', async () => {
    const task = {
      title: 'Fix the crash!',
      context: 'c',
      suggestedAssignee: 'lead_programmer',
      evidence: "Arjun, let's start with the build.",
    };
    const { tasks, notetaker, feed } = setup((_messages, call) =>
      [
        reply({ newTasks: [task], newQuestions: [{ text: 'Final build date?' }] }),
        reply({ newTasks: [{ ...task, title: 'fix the crash' }], newQuestions: [{ text: 'final build date' }] }),
        reply({ answeredQuestionIds: ['q-1'] }),
      ][call]!,
    );

    for (let pass = 0; pass < 3; pass += 1) {
      feed(slice(0, 30));
      await notetaker.run();
    }

    expect(tasks.list()).toHaveLength(1);
    expect(notetaker.state().openQuestions).toEqual([]);
  });

  it('only moves the agenda forward', async () => {
    const { notetaker, feed, onAgendaIndex } = setup(
      (_messages, call) => reply({ agendaIndex: [0, 2, 1][call] }),
      1,
    );

    for (let pass = 0; pass < 3; pass += 1) {
      feed(slice(0, 30));
      await notetaker.run();
    }

    expect(onAgendaIndex.mock.calls).toEqual([[2]]);
  });

  it('keeps the last good record when the LLM is down, then resends the missed lines', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let down = false;
    const { llm, notetaker, feed } = setup(() => {
      if (down) throw new Error('gateway unreachable');
      return reply({ newQuestions: [{ text: 'Final build date?' }] });
    });

    feed(slice(0, 30));
    await notetaker.run();

    down = true;
    feed(slice(30, 100));
    await notetaker.run();
    expect(notetaker.state()).toMatchObject({
      status: 'stale',
      lastError: 'gateway unreachable',
      openQuestions: [{ id: 'q-1', text: 'Final build date?' }],
    });

    down = false;
    feed(slice(100, 130));
    await notetaker.run();
    expect(notetaker.state().status).toBe('ok');
    const resent = userMessage(llm.calls[2]!);
    expect(resent).toContain('Release candidate two');
    expect(resent).toContain('That blocks the launch build then.');
  });

  it('treats a reply that is not JSON as a failed pass', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { notetaker, feed } = setup(() => 'Sure! Here are the tasks: ...');

    feed(slice(0, 30));
    await notetaker.run();

    expect(notetaker.state().status).toBe('stale');
  });

  it('runs one pass at a time', async () => {
    let release: (value: string) => void = () => {};
    const { llm, notetaker, feed } = setup(() => new Promise<string>((resolve) => (release = resolve)));

    feed(slice(0, 30));
    const first = notetaker.run();
    feed(slice(30, 60));
    await notetaker.run();
    expect(llm.calls).toHaveLength(1);

    release(reply({}));
    await first;
  });

  it('without an LLM only keeps talk time', async () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario });
    const notetaker = createNotetaker({ scenario, tasks, agendaIndex: () => 0 });

    notetaker.addChunk({ speaker: 'Arjun', text: 'one two three four five' });
    await notetaker.run();

    expect(notetaker.state()).toMatchObject({ status: 'off', openQuestions: [] });
    expect(notetaker.state().talkSecondsFor(0)).toEqual({ lead_programmer: 2 });
  });
});

describe('task precision', () => {
  const candidate = (title: string, suggestedAssignee: string, evidence: string, extra = {}) => ({
    title,
    context: title,
    suggestedAssignee,
    evidence,
    ...extra,
  });

  it('drops a task whose evidence nobody said', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tasks, notetaker, feed } = setup(() =>
      reply({
        newTasks: [
          candidate('Order new office chairs', 'producer', 'Wei Ling promised to order new chairs for everyone'),
          candidate('File the crash bug', 'lead_programmer', "Yes, I'll file it today."),
        ],
      }),
    );

    feed(slice(120, 160));
    await notetaker.run();

    expect(tasks.list().map((task) => task.title)).toEqual(['File the crash bug']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Order new office chairs'));
  });

  it('skips tasks the LLM marks as duplicates and reworded duplicates for the same role', async () => {
    const { tasks, notetaker, feed } = setup((_messages, call) =>
      [
        reply({
          newTasks: [
            candidate('Fix crash after serving ten customers in a row', 'lead_programmer', 'the game crashes'),
            candidate('Confirm Starfruit final build deadline', 'producer', 'I remember an email from them saying earlier'),
          ],
        }),
        reply({
          newTasks: [
            candidate('File bug ticket for ten-customer crash with repro steps', 'lead_programmer', "Yes, I'll file it today."),
            candidate('Track the ten customer crash', 'lead_programmer', "Yes, I'll file it today.", {
              duplicateOf: 'task-1',
            }),
            candidate(
              'Post launch date in team channel once final build date is confirmed',
              'producer',
              "I'll post the launch date in the team channel",
            ),
          ],
        }),
      ][call]!,
    );

    feed([...slice(0, 100), ...slice(1300, 1310)]);
    await notetaker.run();
    feed([...slice(100, 200), ...slice(1530, 1540)]);
    await notetaker.run();

    expect(tasks.list().map((task) => task.title)).toEqual([
      'Fix crash after serving ten customers in a row',
      'Confirm Starfruit final build deadline',
      'Post launch date in team channel once final build date is confirmed',
    ]);
  });

  it('matches evidence word for word and compares tasks by their keywords', () => {
    const lines = [{ text: "Yes, I'll file it today. I think it's the order queue." }];
    expect(isGrounded("I'll file it today", lines)).toBe(true);
    expect(isGrounded('Yes, I will definitely raise a ticket', lines)).toBe(false);
    expect(isGrounded('file it', lines)).toBe(false);

    const existing = [
      { id: 't', title: 'Fix pause menu text overlap', context: '', suggestedAssignee: 'lead_programmer', status: 'SUGGESTED', updatedAt: '' },
    ] as const;
    const same = { title: 'Pause menu text overlaps on small screens', context: '', suggestedAssignee: 'lead_programmer' };
    expect(isLikelyDuplicate(same, [...existing])).toBe(true);
    expect(isLikelyDuplicate({ ...same, suggestedAssignee: 'producer' }, [...existing])).toBe(false);
    expect(
      isLikelyDuplicate({ title: 'Fix tutorial skip button', context: '', suggestedAssignee: 'lead_programmer' }, [...existing]),
    ).toBe(false);
  });

  it('says how many lines it had to drop during a long outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { notetaker } = setup(() => reply({}));

    for (let line = 0; line < 205; line += 1) notetaker.addChunk({ speaker: 'Arjun', text: `line ${line}` });
    await notetaker.run();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped the 5 oldest transcript lines'));
  });
});

describe('talk time', () => {
  it('counts talk time per role for each agenda item and spots the quiet marketing lead', async () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario });
    let agendaIndex = 0;
    const notetaker = createNotetaker({ scenario, tasks, agendaIndex: () => agendaIndex });

    for (const line of replay) {
      agendaIndex = line.agendaIndex ?? agendaIndex;
      notetaker.addChunk(line);
    }
    notetaker.addChunk({ speaker: 'Kaki', text: 'Not an attendee, so not counted.' });

    const state = notetaker.state();
    expect(Object.keys(state.talkSecondsFor(1)).sort()).toEqual(['game_designer', 'lead_programmer', 'producer']);
    expect(state.talkSecondsFor(1).game_designer).toBeGreaterThan(state.talkSecondsFor(1).producer!);
    expect(state.talkSecondsFor(3).marketing_lead).toBeGreaterThan(0);
    expect(state.quietRoles).toEqual(['marketing_lead']);
  });

  it('calls nobody quiet before there is enough talk to judge', () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario });
    const notetaker = createNotetaker({ scenario, tasks, agendaIndex: () => 0 });

    notetaker.addChunk({ speaker: 'Arjun', text: 'Short update.' });

    expect(notetaker.state().quietRoles).toEqual([]);
  });
});

describe('notetaker reply parsing', () => {
  it('drops items that do not fit the scenario and keeps the rest', () => {
    const parsed = parseNotetakerReply(
      '```json\n' +
        JSON.stringify({
          agendaIndex: 9,
          newQuestions: [{ text: 'Who owns QA?', forRole: 'qa_lead' }, { text: '' }, 'nope'],
          answeredQuestionIds: ['q-1', 3],
          newTasks: [
            {
              title: 'Book tablets',
              context: 'For the booth.',
              suggestedAssignee: 'producer',
              actionKind: 'fax',
              evidence: 'we save about four hundred',
            },
            { title: 'No evidence', context: 'x', suggestedAssignee: 'producer' },
            { title: 'Ghost task', context: 'x', suggestedAssignee: 'qa_lead' },
            { context: 'no title', suggestedAssignee: 'producer' },
          ],
        }) +
        '\n```',
      scenario,
    );

    expect(parsed).toEqual({
      agendaIndex: undefined,
      newQuestions: [{ text: 'Who owns QA?' }],
      answeredQuestionIds: ['q-1'],
      newTasks: [
        { title: 'Book tablets', context: 'For the booth.', suggestedAssignee: 'producer', evidence: 'we save about four hundred' },
      ],
    });
  });

  it('rejects a reply that is not a JSON object', () => {
    expect(() => parseNotetakerReply('[]', scenario)).toThrow(/object/);
    expect(() => parseNotetakerReply('nope', scenario)).toThrow(/JSON/);
  });
});
