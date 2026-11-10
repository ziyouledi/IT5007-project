import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import {
  createNotetaker,
  hasTaskAssignment,
  isGrounded,
  isHypotheticalProposal,
  isLikelyDuplicate,
  isLikelyDuplicateQuestion,
  parseNotetakerReply,
  taskMatchesAssignment,
} from '../../src/host/notetaker';
import { loadReplay, type ReplayLine } from '../../src/host/replay';
import { createFakeLlm, type ChatMessage } from '../../src/llm';
import { loadScenario } from '../../src/loadScenario';
import { createTaskStore } from '../../src/tasks';

function quietHub(): Hub {
  return {
    publish: (_event: KakiEvent) => {},
    subscribe: () => () => {},
    onCommand: () => {},
    clearRetained: () => {},
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
  scenario = await loadScenario('kopitiam');
  replay = await loadReplay(scenario, 'kopitiam');
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
  const setAgendaIndex = (index: number) => {
    agendaIndex = index;
  };
  return { tasks, llm, notetaker, feed, onAgendaIndex, setAgendaIndex };
}

describe('notetaker on canned Nanyang Kopi & Toast slices', () => {
  it('suggests the scripted tasks and records the scripted questions', async () => {
    const { tasks, llm, notetaker, feed } = setup((messages) => {
      const text = newLines(messages);
      if (text.includes("draft the regulars' note")) {
        return reply({
          newQuestions: [
            { text: 'Who counts as a regular?', forRole: 'producer' },
            { text: 'Where does a solo diner sit while the queue clears?', forRole: 'producer' },
          ],
          newTasks: [
            {
              title: 'Draft the regulars note',
              context: 'Draft the regulars note with the old price explained at the counter.',
              suggestedAssignee: 'game_designer',
              actionKind: 'gitea_issue',
              evidence: "Mei, can you draft the regulars' note for the counter and Facebook?",
            },
          ],
        });
      }
      if (text.includes('set the booth socket timer')) {
        return reply({
          agendaIndex: 2,
          newQuestions: [{ text: 'Who sets the booth socket timer before 8?', forRole: 'producer' }],
        });
      }
      if (text.includes('email GrabFood')) {
        return reply({
          agendaIndex: 3,
          newTasks: [
            {
              title: 'Email GrabFood to confirm the five-set platter listing',
              context: 'Confirm the five-set platter listing for tomorrow.',
              suggestedAssignee: 'marketing_lead',
              actionKind: 'email',
              evidence: "Yes, I'll email GrabFood to confirm the platter listing, and I'll send the pickup code to the offices.",
            },
            {
              title: 'Post the final plan in the team channel',
              context: 'Post the agreed launch plan in the team channel once the delivery decision is settled.',
              suggestedAssignee: 'producer',
              actionKind: 'mattermost_post',
              evidence: "I'll post the final plan in the team channel once we settle the pickup code.",
            },
          ],
        });
      }
      return reply({});
    });

    for (const [from, to] of [
      [0, 360],
      [360, 1000],
      [1000, 1450],
      [1450, 2200],
    ] as const) {
      feed(slice(from, to));
      await notetaker.run();
    }

    expect(llm.calls).toHaveLength(4);
    expect(tasks.list().map((task) => [task.suggestedAssignee, task.actionKind, task.status])).toEqual([
      ['game_designer', 'gitea_issue', 'SUGGESTED'],
      ['marketing_lead', 'email', 'SUGGESTED'],
      ['producer', 'mattermost_post', 'SUGGESTED'],
    ]);
    expect(notetaker.state().openQuestions).toEqual([
      { id: 'q-1', text: 'Who counts as a regular?', forRole: 'producer', agendaIndex: 0 },
      { id: 'q-2', text: 'Where does a solo diner sit while the queue clears?', forRole: 'producer', agendaIndex: 0 },
      { id: 'q-3', text: 'Who sets the booth socket timer before 8?', forRole: 'producer', agendaIndex: 2 },
    ]);
    expect(notetaker.state().status).toBe('ok');
  });

  it('tells the LLM who spoke, what is open, what was already suggested and the earlier decision context', async () => {
    const { llm, notetaker, feed } = setup((_messages, call) =>
      call === 0
        ? reply({
            newQuestions: [{ text: 'Who counts as a regular?' }],
            newTasks: [
              {
                title: 'Draft the regulars note',
                context: 'Draft the regulars note with the old price explained at the counter.',
                suggestedAssignee: 'game_designer',
                evidence: "Mei, can you draft the regulars' note for the counter and Facebook?",
              },
            ],
          })
        : reply({}),
    );

    feed(slice(0, 100));
    notetaker.addChunk({ speaker: 'Wei Ling', text: "Mei, can you draft the regulars' note for the counter and Facebook?" });
    await notetaker.run();
    feed(slice(100, 200));
    await notetaker.run();

    const [system, user] = llm.calls[1]!;
    expect(system!.content).toContain('lead_programmer: Tech & POS Lead (Arjun)');
    expect(system!.content).toContain(scenario.agenda[0]!.title);
    expect(user!.content).toContain('- q-1: Who counts as a regular?');
    expect(user!.content).toMatch(/- task-[\w-]+: Draft the regulars note \(owner: game_designer\) — Draft the regulars note with the old price explained at the counter\./);
    expect(user!.content).toContain('[Arjun (Tech & POS Lead)] Anyone new on the till needs a login');
    // Earlier lines travel as context, while the new-lines section still carries only the batch since the last pass.
    expect(user!.content).toContain('[Wei Ling (Operations Director)] First topic');
    expect(user!.content.split('New transcript lines:')[1] ?? '').not.toContain('First topic');
  });
});

describe('notetaker record keeping', () => {
  it('does not repeat a task or question the meeting already has, and drops answered questions', async () => {
    const task = {
      title: 'Review the trial numbers',
      context: 'c',
      suggestedAssignee: 'game_designer',
      evidence: "I'll review the trial numbers tonight.",
    };
    const { tasks, notetaker, feed } = setup((_messages, call) =>
      [
        reply({ newTasks: [task], newQuestions: [{ text: 'Who covers the counter?' }] }),
        reply({ newTasks: [{ ...task, title: 'review the trial numbers' }], newQuestions: [{ text: 'Who covers the counter?' }] }),
        reply({
          answeredQuestions: [{ id: 'q-1', evidence: 'Mei covers the counter with two staff and one off.' }],
        }),
      ][call]!,
    );

    notetaker.addChunk({ speaker: 'Wei Ling', text: "I'll review the trial numbers tonight." });
    notetaker.addChunk({ speaker: 'Mei', text: 'Mei covers the counter with two staff and one off.' });
    for (let pass = 0; pass < 3; pass += 1) {
      feed(slice(0, 40));
      await notetaker.run();
    }

    expect(tasks.list()).toHaveLength(1);
    expect(notetaker.state().openQuestions).toEqual([]);
  });

  it('keeps a re-asked question when the same reply closes the older wording', async () => {
    const { notetaker } = setup((_messages, call) =>
      [
        reply({ newQuestions: [{ text: 'Where do players quit?' }] }),
        reply({
          answeredQuestions: [{ id: 'q-1', evidence: 'Players quit at the second level.' }],
          newQuestions: [{ text: 'Where do players quit in the game?' }],
        }),
      ][call]!,
    );

    for (let pass = 0; pass < 2; pass += 1) {
      notetaker.addChunk({ speaker: 'Mei', text: pass === 0 ? 'Where do players quit?' : 'Players quit at the second level.' });
      await notetaker.run();
    }

    expect(notetaker.state().openQuestions.map((question) => question.text)).toEqual(['Where do players quit in the game?']);
  });

  it('keeps the cash owner and change/float questions as separate open questions', async () => {
    const { notetaker, feed } = setup((_messages, call) =>
      [
        reply({ newQuestions: [{ text: 'Who runs the counter at 8?' }] }),
        reply({ newQuestions: [{ text: 'How is change counted and balanced at close?' }] }),
      ][call]!,
    );

    feed(slice(900, 1000));
    await notetaker.run();
    feed(slice(1000, 1100));
    await notetaker.run();

    expect(notetaker.state().openQuestions.map((question) => question.text)).toEqual([
      'Who runs the counter at 8?',
      'How is change counted and balanced at close?',
    ]);
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
      return reply({ newQuestions: [{ text: 'Who covers the counter?' }] });
    });

    feed(slice(0, 30));
    await notetaker.run();

    down = true;
    feed(slice(30, 100));
    await notetaker.run();
    expect(notetaker.state()).toMatchObject({
      status: 'stale',
      lastError: 'gateway unreachable',
      openQuestions: [{ id: 'q-1', text: 'Who covers the counter?' }],
    });

    down = false;
    feed(slice(100, 130));
    await notetaker.run();
    expect(notetaker.state().status).toBe('ok');
    const resent = userMessage(llm.calls[2]!);
    expect(resent).toContain('free-kopi flyers');
    expect(resent).toContain('double pay');
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
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          candidate('Order new office chairs', 'producer', 'Wei Ling promised to order new chairs for everyone'),
          candidate(
            'Draft the regulars note',
            'game_designer',
            "Mei, can you draft the regulars' note for the counter and Facebook?",
          ),
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Wei Ling', text: "Mei, can you draft the regulars' note for the counter and Facebook?" });
    await notetaker.run();

    expect(tasks.list().map((task) => task.title)).toEqual(['Draft the regulars note']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Order new office chairs'));
  });

  it('skips tasks the LLM marks as duplicates and reworded duplicates for the same role', async () => {
    const trialTask = "Mei, can you review the trial numbers tonight?";
    const butterTask = 'Wei Ling, can you review the butter margin figures tonight?';
    const { tasks, notetaker } = setup((_messages, call) => {
      if (call === 0) {
        return reply({
          newTasks: [
            candidate('Review trial numbers', 'game_designer', trialTask),
            candidate('Review the butter margin', 'producer', butterTask),
          ],
        });
      }
      return reply({
        newTasks: [
          candidate('Review the trial numbers', 'game_designer', trialTask),
          candidate('Track the seat trial numbers', 'game_designer', trialTask, {
            duplicateOf: tasks.list()[0]?.id ?? 'missing-task',
          }),
          candidate(
            'Post the butter plan in the team channel',
            'producer',
            "I'll post the final plan in the team channel once we settle the pickup code.",
          ),
        ],
      });
    });

    notetaker.addChunk({ speaker: 'Mei', text: trialTask });
    notetaker.addChunk({ speaker: 'Wei Ling', text: butterTask });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Wei Ling', text: "I'll post the final plan in the team channel once we settle the pickup code." });
    await notetaker.run();

    expect(tasks.list().map((task) => task.title)).toEqual([
      'Review trial numbers',
      'Review the butter margin',
      'Post the butter plan in the team channel',
    ]);
  });

  it('does not invent a partner-terms task from a price quote or reuse the final-plan post for it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          candidate(
            'Confirm GrabFood platter promotion terms (rate and vouchers)',
            'studio_manager',
            'GrabFood takes a bigger cut from today, and we lose about 50 cents on each $10 breakfast set delivered.',
            { actionKind: 'mattermost_post' },
          ),
          candidate(
            'Confirm GrabFood platter promotion terms (rate and vouchers)',
            'studio_manager',
            "I'll post the final plan in the team channel once we settle the pickup code.",
            { actionKind: 'mattermost_post' },
          ),
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Daniel', text: 'GrabFood takes a bigger cut from today, and we lose about 50 cents on each $10 breakfast set delivered.' });
    notetaker.addChunk({ speaker: 'Wei Ling', text: "I'll post the final plan in the team channel once we settle the pickup code." });
    await notetaker.run();

    expect(tasks.list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not assign or volunteer'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match the assignment'));
  });

  it('does not borrow the deliverable of a neighbouring line, and drops a task with no concrete words', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          candidate(
            'Post the delivery plan in the team channel',
            'producer',
            "I'll email GrabFood tonight and confirm the details.",
            { actionKind: 'mattermost_post' },
          ),
          candidate('Email the egg supplier', 'producer', "I'll email GrabFood tonight and confirm the details.", {
            actionKind: 'email',
          }),
          candidate('Send the update', 'producer', "I'll email GrabFood tonight and confirm the details.", {
            actionKind: 'email',
          }),
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Mei', text: 'The delivery plan needs a decision.' });
    notetaker.addChunk({ speaker: 'Wei Ling', text: "I'll email GrabFood tonight and confirm the details." });
    await notetaker.run();

    expect(tasks.list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match the assignment'));
  });

  it('keeps the conditional final-plan post and the GrabFood email when they are explicitly committed', async () => {
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          candidate('Email GrabFood to confirm the five-set platter listing', 'marketing_lead', "Yes, I'll email GrabFood to confirm the platter listing, and I'll send the pickup code to the offices.", {
            actionKind: 'email',
          }),
          candidate(
            'Post the final plan in the team channel',
            'producer',
            "I'll post the final plan in the team channel once we settle the pickup code.",
            { actionKind: 'mattermost_post' },
          ),
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Daniel', text: "Yes, I'll email GrabFood to confirm the platter listing, and I'll send the pickup code to the offices." });
    notetaker.addChunk({ speaker: 'Wei Ling', text: "I'll post the final plan in the team channel once we settle the pickup code." });
    await notetaker.run();

    expect(tasks.list().map((task) => [task.title, task.suggestedAssignee, task.actionKind])).toEqual([
      ['Email GrabFood to confirm the five-set platter listing', 'marketing_lead', 'email'],
      ['Post the final plan in the team channel', 'producer', 'mattermost_post'],
    ]);
  });

  it('keeps an explicit named volunteer task owned by the speaker despite the model suggesting another role', async () => {
    const line =
      'Confirmed, that is my decision. I, Booth Playtest, will post the agreed plan in the team channel today. ' +
      'Please assign that Mattermost handover to me so I can review the draft.';
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          candidate('Post the agreed plan in the team channel', 'studio_manager', line, {
            actionKind: 'mattermost_post',
          }),
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Wei Ling (Operations Director)', text: line });
    await notetaker.run();

    expect(tasks.list().map((task) => [task.title, task.suggestedAssignee])).toEqual([
      ['Post the agreed plan in the team channel', 'producer'],
    ]);
  });

  it('preserves grounded self-volunteer evidence from the real speaker and role mapping', async () => {
    const line = 'I will update the signage to point to the new cash desk.';
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [candidate('Update signage to point to the new cash desk', 'game_designer', line)],
      }),
    );

    notetaker.addChunk({ speaker: 'Arjun', text: line });
    await notetaker.run();

    expect(tasks.list().map((task) => [task.title, task.suggestedAssignee, task.assignmentEvidence])).toEqual([
      [
        'Update signage to point to the new cash desk',
        'lead_programmer',
        {
          speaker: 'Arjun',
          quote: line,
          scope: {
            title: 'Update signage to point to the new cash desk',
            context: 'Update signage to point to the new cash desk',
          },
        },
      ],
    ]);
  });

  it('snapshots the final cleaned task, including its action kind, as the commitment scope', async () => {
    const line = "I'll post the opening plan in the team channel today.";
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          candidate('Post the opening plan in the team channel', 'producer', line, {
            actionKind: 'mattermost_post',
          }),
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Mei', text: line });
    await notetaker.run();

    expect(tasks.list()[0]?.assignmentEvidence).toEqual({
      speaker: 'Mei',
      quote: line,
      scope: {
        title: 'Post the opening plan in the team channel',
        context: 'Post the opening plan in the team channel',
        actionKind: 'mattermost_post',
      },
    });
  });

  it('does not record assignment evidence for a request addressed to someone else', async () => {
    const line = 'Arjun, can you update the signage to point to the new cash desk?';
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [candidate('Update signage to point to the new cash desk', 'lead_programmer', line)],
      }),
    );

    notetaker.addChunk({ speaker: 'Wei Ling', text: line });
    await notetaker.run();

    expect(tasks.list().map((task) => [task.suggestedAssignee, task.assignmentEvidence])).toEqual([
      ['lead_programmer', undefined],
    ]);
  });

  it('does not record assignment evidence when the speaker delegates the work to a named colleague', async () => {
    const line = 'I will ask Mei to update the signage to point to the new cash desk.';
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [candidate('Update signage to point to the new cash desk', 'lead_programmer', line)],
      }),
    );

    notetaker.addChunk({ speaker: 'Arjun', text: line });
    await notetaker.run();

    expect(tasks.list().map((task) => [task.suggestedAssignee, task.assignmentEvidence])).toEqual([
      ['lead_programmer', undefined],
    ]);
  });

  it.each([
    ['a third-person future statement', 'Sam Booth Playtest will post the agreed plan in the team channel today.'],
    ['a named remark with no commitment', 'I, Booth Playtest, think the agreed plan is good.'],
  ])('drops a named remark that is not a first-person commitment: %s', async (_label, line) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          candidate('Post the agreed plan in the team channel', 'studio_manager', line, {
            actionKind: 'mattermost_post',
          }),
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Wei Ling (Operations Director)', text: line });
    await notetaker.run();

    expect(tasks.list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not assign or volunteer'));
  });

  it('matches evidence word for word and compares tasks by their keywords', () => {
    const lines = [{ text: "Yes, I'll file it today. I think it's the order queue." }];
    expect(isGrounded("I'll file it today", lines)).toBe(true);
    expect(isGrounded('Yes, I will definitely raise a ticket', lines)).toBe(false);
    expect(isGrounded('file it', lines)).toBe(false);

    const existing = [
      { id: 't', title: 'Fix pause menu text overlap', context: '', suggestedAssignee: 'lead_programmer',
        agendaItemTitle: 'Kiosk rollout', status: 'SUGGESTED', updatedAt: '' },
    ] as const;
    const same = { title: 'Pause menu text overlaps on small screens', context: '', suggestedAssignee: 'lead_programmer',
      agendaItemTitle: 'Kiosk rollout' };
    expect(isLikelyDuplicate(same, [...existing])).toBe(true);
    expect(isLikelyDuplicate({ ...same, suggestedAssignee: 'producer' }, [...existing])).toBe(false);
    expect(isLikelyDuplicate({ ...same, agendaItemTitle: 'Delivery costs' }, [...existing])).toBe(false);
    expect(
      isLikelyDuplicate({ title: 'Fix tutorial skip button', context: '', suggestedAssignee: 'lead_programmer',
        agendaItemTitle: 'Kiosk rollout' }, [...existing]),
    ).toBe(false);
  });

  it('says how many lines it had to drop during a long outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { notetaker } = setup(() => reply({}));

    for (let line = 0; line < 205; line += 1) notetaker.addChunk({ speaker: 'Arjun', text: `line ${line}` });
    await notetaker.run();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped the 5 oldest transcript lines'));
  });

  it('keeps the agreed decision in the task context without appending raw speech fragments', async () => {
    const kopitiamScenario = await loadScenario('kopitiam');
    const tasks = createTaskStore({ hub: quietHub(), scenario: kopitiamScenario });
    const decision =
      'Announce in the team channel today that we decided to move the cash box away from the food prep area.';
    const llm = createFakeLlm(() =>
      reply({
        newTasks: [
          candidate(
            'Post cash box decision in team channel',
            'producer',
            'Feifei Li, could you post that decision in the team channel today so everyone has it?',
            { context: decision, actionKind: 'mattermost_post' },
          ),
        ],
      }),
    );
    const notetaker = createNotetaker({ scenario: kopitiamScenario, tasks, llm, agendaIndex: () => 1 });
    notetaker.addChunk({ speaker: 'Feifei Li', text: 'We should separate cash collection from food prep.' });
    notetaker.addChunk({ speaker: 'Arjun', text: 'Move the counter?' });
    notetaker.addChunk({ speaker: 'Feifei Li', text: 'Whatever that that that that box. Away from the food, right?' });
    notetaker.addChunk({ speaker: 'Mei', text: 'So we move the cash box away from the food prep area.' });
    notetaker.addChunk({
      speaker: 'Mei',
      text: 'Feifei Li, could you post that decision in the team channel today so everyone has it?',
    });
    await notetaker.run();

    const [task] = tasks.list();
    expect(task?.context).toBe(decision);
    expect(task?.context).not.toContain('Whatever that that that that box');
    expect(task?.context).not.toContain('Move the counter?');
  });

  it('routes a natural second-person task request ("Could you post...") to the visitor role even when zoomDisplayName has no parentheses', async () => {
    const kopitiamScenario = await loadScenario('kopitiam');
    const tasks = createTaskStore({ hub: quietHub(), scenario: kopitiamScenario });
    const llm = createFakeLlm(() =>
      reply({
        newTasks: [
          candidate(
            'Post the regulars price decision in team channel',
            'game_designer',
            'Feifei Li, could you post that decision in the team channel today so everyone has it?',
            { actionKind: 'mattermost_post' },
          ),
        ],
      }),
    );
    const notetaker = createNotetaker({ scenario: kopitiamScenario, tasks, llm, agendaIndex: () => 1 });
    notetaker.addChunk({ speaker: 'Wei Ling', text: 'Let us add the regulars price on the till.' });
    notetaker.addChunk({
      speaker: 'Mei',
      text: 'Got it, we will add the regulars price on the till tonight. Feifei Li, could you post that decision in the team channel today so everyone has it?',
    });
    await notetaker.run();
    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]?.suggestedAssignee).toBe('producer');
  });
});

describe('decision context across notetaker batches', () => {
  const seatingDecision =
    'We will run the booth rule from 8 to 10:30 AM, the floor managers enforce it, and we measure table turnover every morning.';

  it('carries an earlier accepted decision into a later batch that only names the assignment', async () => {
    const { llm, notetaker, setAgendaIndex } = setup(() => reply({}), 1);
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({
      speaker: 'Mei',
      text: 'Feifei Li, can you post that decision in the team channel today so everyone has it?',
    });
    await notetaker.run();

    expect(llm.calls).toHaveLength(2);
    const assignmentPrompt = userMessage(llm.calls[1]!);
    expect(assignmentPrompt).toContain('Earlier lines on this agenda item');
    expect(assignmentPrompt).toContain(seatingDecision);
  });

  it('drops a superseded decision instead of mixing it with the correction', async () => {
    const corrected =
      'Actually wait, make it 8:30 to 10 AM; the floor managers still enforce it and we measure table turnover.';
    const { llm, notetaker, setAgendaIndex } = setup(() => reply({}), 1);
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Feifei Li', text: corrected });
    await notetaker.run();
    notetaker.addChunk({
      speaker: 'Mei',
      text: 'Feifei Li, can you post the corrected decision in the team channel today?',
    });
    await notetaker.run();

    const assignmentPrompt = userMessage(llm.calls[2]!);
    expect(assignmentPrompt).toContain(corrected);
    expect(assignmentPrompt).not.toContain(seatingDecision);
  });

  it('does not leak a decision from another agenda item into a later task prompt', async () => {
    const { llm, notetaker, setAgendaIndex } = setup(() => reply({}), 1);
    setAgendaIndex(1);
    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();

    setAgendaIndex(2);
    notetaker.addChunk({
      speaker: 'Mei',
      text: 'Feifei Li, can you email the cash float figures to the supplier today?',
    });
    await notetaker.run();

    const cashPrompt = userMessage(llm.calls[1]!);
    expect(cashPrompt).not.toContain(seatingDecision);
    expect(cashPrompt).toContain('Earlier lines on this agenda item');
  });

  it('stores the accepted decision verbatim on the task', async () => {
    const assignment = 'Mei, can you post the seating decision in the team channel today so everyone has it?';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) =>
        call === 0
          ? reply({})
          : reply({
              newTasks: [
                {
                  title: 'Post the seating decision in the team channel',
                  context: 'Announce the seating rule.',
                  suggestedAssignee: 'game_designer',
                  actionKind: 'mattermost_post',
                  evidence: assignment,
                  decisionEvidence: seatingDecision,
                },
              ],
            }),
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: assignment });
    await notetaker.run();

    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]).toMatchObject({
      title: 'Post the seating decision in the team channel',
      decisionSource: seatingDecision,
    });
  });

  it('stores the transcript line, not the model paraphrase, as the accepted decision source', async () => {
    const assignment = 'Mei, can you post the seating decision in the team channel today so everyone has it?';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) =>
        call === 0
          ? reply({})
          : reply({
              newTasks: [
                {
                  title: 'Post the seating decision in the team channel',
                  context: 'Announce the seating rule.',
                  suggestedAssignee: 'game_designer',
                  actionKind: 'mattermost_post',
                  evidence: assignment,
                  decisionEvidence:
                    'We will run the booth rule from 8 to 10:30 AM, and we measure table turnover every morning.',
                },
              ],
            }),
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: assignment });
    await notetaker.run();

    // A near-match resolves to the real transcript line; the model's own wording is never stored.
    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]?.decisionSource).toBe(seatingDecision);
  });

  it('leaves the decision source empty when the model quote is not in the transcript', async () => {
    const assignment = 'Mei, can you post the seating decision in the team channel today so everyone has it?';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) =>
        call === 0
          ? reply({})
          : reply({
              newTasks: [
                {
                  title: 'Post the seating decision in the team channel',
                  context: 'Announce the seating rule.',
                  suggestedAssignee: 'game_designer',
                  actionKind: 'mattermost_post',
                  evidence: assignment,
                  decisionEvidence: 'We will order extra napkins for the lunch crowd.',
                },
              ],
            }),
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: assignment });
    await notetaker.run();

    // No source is fabricated when the quote cannot be grounded.
    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]?.decisionSource).toBeUndefined();
  });

  it('keeps one announcement when a different owner is asked for the same decision', async () => {
    const first = 'Mei, can you post the seating decision in the team channel today so everyone has it?';
    const second = 'Daniel, can you also announce the seating decision in the team channel today?';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) =>
        call === 0
          ? reply({})
          : reply({
              newTasks: [
                {
                  title: 'Post the seating decision in the team channel',
                  context: 'Announce the seating rule.',
                  suggestedAssignee: 'game_designer',
                  actionKind: 'mattermost_post',
                  evidence: first,
                  decisionEvidence: seatingDecision,
                },
                {
                  title: 'Announce the seating rule in the team channel',
                  context: 'Announce the seating rule.',
                  suggestedAssignee: 'marketing_lead',
                  actionKind: 'mattermost_post',
                  evidence: second,
                  decisionEvidence: seatingDecision,
                },
              ],
            }),
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: first });
    notetaker.addChunk({ speaker: 'Daniel', text: second });
    await notetaker.run();

    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]?.suggestedAssignee).toBe('game_designer');
  });

  it('keeps separate announcements for two different decisions', async () => {
    const cashDecision =
      'We will keep one cashier on the till from 8 to 11 AM, Wei Ling owns it, and we count the float at close every night.';
    const seatingAssignment = 'Mei, can you post the seating decision in the team channel today so everyone has it?';
    const cashAssignment = 'Wei Ling, can you post the cash decision in the team channel today so everyone has it?';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) =>
        call === 0
          ? reply({})
          : reply({
              newTasks: [
                {
                  title: 'Post the seating decision in the team channel',
                  context: 'Announce the seating rule.',
                  suggestedAssignee: 'game_designer',
                  actionKind: 'mattermost_post',
                  evidence: seatingAssignment,
                  decisionEvidence: seatingDecision,
                },
                {
                  title: 'Post the cash decision in the team channel',
                  context: 'Announce the till and float rule.',
                  suggestedAssignee: 'producer',
                  actionKind: 'mattermost_post',
                  evidence: cashAssignment,
                  decisionEvidence: cashDecision,
                },
              ],
            }),
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    notetaker.addChunk({ speaker: 'Wei Ling', text: cashDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: seatingAssignment });
    notetaker.addChunk({ speaker: 'Wei Ling', text: cashAssignment });
    await notetaker.run();

    expect(tasks.list().map((task) => [task.title, task.decisionSource]).sort()).toEqual([
      ['Post the cash decision in the team channel', cashDecision],
      ['Post the seating decision in the team channel', seatingDecision],
    ]);
  });

  it('stores the corrected decision and ignores the one it replaced', async () => {
    const corrected =
      'Actually wait, make it 8:30 to 10 AM; the floor managers still enforce it and we measure table turnover.';
    const assignment = 'Mei, can you post the corrected decision in the team channel today?';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) =>
        call === 2
          ? reply({
              newTasks: [
                {
                  title: 'Post the corrected seating decision in the team channel',
                  context: 'Announce the corrected seating rule.',
                  suggestedAssignee: 'game_designer',
                  actionKind: 'mattermost_post',
                  evidence: assignment,
                  decisionEvidence: corrected,
                },
              ],
            })
          : reply({}),
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Feifei Li', text: corrected });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: assignment });
    await notetaker.run();

    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]?.decisionSource).toBe(corrected);
  });

  it('ignores a stale decision quote after a correction', async () => {
    const corrected =
      'Actually wait, make it 8:30 to 10 AM; the floor managers still enforce it and we measure table turnover.';
    const assignment = 'Mei, can you post the corrected decision in the team channel today?';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) =>
        call === 2
          ? reply({
              newTasks: [
                {
                  title: 'Post the corrected seating decision in the team channel',
                  context: 'Announce the corrected seating rule.',
                  suggestedAssignee: 'game_designer',
                  actionKind: 'mattermost_post',
                  evidence: assignment,
                  decisionEvidence: seatingDecision,
                },
              ],
            })
          : reply({}),
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Feifei Li', text: corrected });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: assignment });
    await notetaker.run();

    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]?.decisionSource).toBeUndefined();
  });
});

describe('duplicate handling across batches', () => {
  const candidate = (title: string, suggestedAssignee: string, evidence: string, extra = {}) => ({
    title,
    context: title,
    suggestedAssignee,
    evidence,
    ...extra,
  });
  const seatingDecision =
    'We will run the booth rule from 8 to 10:30 AM, the floor managers enforce it, and we measure table turnover every morning.';
  const cashDecision =
    'We will keep one cashier on the till from 8 to 11 AM, Wei Ling owns it, and we count the float at close every night.';
  const seatingAssignment = 'Mei, can you post the seating decision in the team channel today so everyone has it?';
  const cashAssignment = 'Mei, can you post the cash decision in the team channel today so everyone has it?';

  it('keeps a task when duplicateOf names no existing task', async () => {
    const assignment = 'Mei, can you review the trial numbers tonight?';
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          candidate('Review the trial numbers', 'game_designer', assignment, { duplicateOf: 'task-invented' }),
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Mei', text: assignment });
    await notetaker.run();

    expect(tasks.list().map((task) => task.title)).toEqual(['Review the trial numbers']);
  });

  it('ignores duplicateOf when it points at a different decision', async () => {
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) => {
        if (call === 0) return reply({});
        if (call === 1) {
          return reply({
            newTasks: [
              {
                title: 'Post the cash decision in the team channel',
                context: 'Announce the till and float rule.',
                suggestedAssignee: 'game_designer',
                actionKind: 'mattermost_post',
                evidence: cashAssignment,
                decisionEvidence: cashDecision,
              },
            ],
          });
        }
        return reply({
          newTasks: [
            {
              title: 'Post the seating decision in the team channel',
              context: 'Announce the seating rule.',
              suggestedAssignee: 'game_designer',
              actionKind: 'mattermost_post',
              evidence: seatingAssignment,
              decisionEvidence: seatingDecision,
              duplicateOf: tasks.list()[0]?.id ?? 'missing-task',
            },
          ],
        });
      },
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: cashDecision });
    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: cashAssignment });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: seatingAssignment });
    await notetaker.run();

    expect(tasks.list().map((task) => task.title).sort()).toEqual([
      'Post the cash decision in the team channel',
      'Post the seating decision in the team channel',
    ]);
  });

  it('does not treat a task as a duplicate of one on another agenda item', async () => {
    const firstAssignment = 'Mei, can you post the response plan in the team channel today?';
    const secondAssignment = 'Mei, can you post the delivery response plan in the team channel today?';
    const { tasks, notetaker, setAgendaIndex } = setup((_messages, call) =>
      call === 0
        ? reply({
            newTasks: [
              candidate('Post the response plan in the team channel', 'game_designer', firstAssignment, {
                actionKind: 'mattermost_post',
              }),
            ],
          })
        : reply({
            newTasks: [
              candidate('Post the delivery response plan in the team channel', 'game_designer', secondAssignment, {
                actionKind: 'mattermost_post',
                duplicateOf: tasks.list()[0]?.id ?? 'missing-task',
              }),
            ],
          }),
    );

    setAgendaIndex(0);
    notetaker.addChunk({ speaker: 'Mei', text: firstAssignment });
    await notetaker.run();
    setAgendaIndex(1);
    notetaker.addChunk({ speaker: 'Mei', text: secondAssignment });
    await notetaker.run();

    expect(tasks.list()).toHaveLength(2);
    expect(tasks.list().map((task) => task.agendaItemTitle)).toEqual([
      scenario.agenda[0]?.title,
      scenario.agenda[1]?.title,
    ]);
  });

  it('keeps one announcement when the same decision is repeated by a different owner in a later batch', async () => {
    const secondAssignment = 'Daniel, can you also announce the seating decision in the team channel today?';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) => {
        if (call === 0) return reply({});
        if (call === 1) {
          return reply({
            newTasks: [
              {
                title: 'Post the seating decision in the team channel',
                context: 'Announce the seating rule.',
                suggestedAssignee: 'game_designer',
                actionKind: 'mattermost_post',
                evidence: seatingAssignment,
                decisionEvidence: seatingDecision,
              },
            ],
          });
        }
        return reply({
          newTasks: [
            {
              title: 'Announce the seating rule in the team channel',
              context: 'Announce the seating rule.',
              suggestedAssignee: 'marketing_lead',
              actionKind: 'mattermost_post',
              evidence: secondAssignment,
              decisionEvidence: seatingDecision,
            },
          ],
        });
      },
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: seatingAssignment });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Daniel', text: secondAssignment });
    await notetaker.run();

    expect(tasks.list().map((task) => [task.title, task.suggestedAssignee])).toEqual([
      ['Post the seating decision in the team channel', 'game_designer'],
    ]);
  });

  it('keeps a post and an email of the same decision as separate deliverables', async () => {
    const emailAssignment = 'Daniel, can you email the seating decision to the supplier today?';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) => {
        if (call === 0) return reply({});
        if (call === 1) {
          return reply({
            newTasks: [
              {
                title: 'Post the seating decision in the team channel',
                context: 'Announce the seating rule.',
                suggestedAssignee: 'game_designer',
                actionKind: 'mattermost_post',
                evidence: seatingAssignment,
                decisionEvidence: seatingDecision,
              },
            ],
          });
        }
        return reply({
          newTasks: [
            {
              title: 'Email the seating decision to the supplier',
              context: 'Send the seating rule to the supplier.',
              suggestedAssignee: 'marketing_lead',
              actionKind: 'email',
              evidence: emailAssignment,
              decisionEvidence: seatingDecision,
            },
          ],
        });
      },
      1,
    );
    setAgendaIndex(1);

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingDecision });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: seatingAssignment });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Daniel', text: emailAssignment });
    await notetaker.run();

    expect(tasks.list().map((task) => [task.title, task.actionKind]).sort()).toEqual([
      ['Email the seating decision to the supplier', 'email'],
      ['Post the seating decision in the team channel', 'mattermost_post'],
    ]);
  });
});

describe('talk time', () => {
  it('counts talk time per role for each agenda item', async () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario });
    let agendaIndex = 0;
    const notetaker = createNotetaker({ scenario, tasks, agendaIndex: () => agendaIndex });

    for (const line of replay) {
      agendaIndex = line.agendaIndex ?? agendaIndex;
      notetaker.addChunk(line);
    }
    notetaker.addChunk({ speaker: 'Kaki', text: 'Not an attendee, so not counted.' });

    const state = notetaker.state();
    expect(Object.keys(state.talkSecondsFor(1)).sort()).toEqual(['game_designer', 'lead_programmer', 'marketing_lead', 'producer', 'studio_manager']);
    expect(state.talkSecondsFor(1).producer).toBeGreaterThan(0);
    expect(state.talkSecondsFor(3).marketing_lead).toBeGreaterThan(0);
  });

  it('spots a role that barely speaks', () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario });
    const notetaker = createNotetaker({ scenario, tasks, agendaIndex: () => 0 });

    for (let line = 0; line < 30; line += 1) {
      notetaker.addChunk({ speaker: 'Wei Ling', text: 'one two three four five six seven eight nine ten' });
    }
    notetaker.addChunk({ speaker: 'Daniel', text: 'Short.' });

    expect(notetaker.state().quietRoles).toContain('marketing_lead');
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

describe('hasTaskAssignment', () => {
  it.each([
    'Would you mind posting the final plan in the team channel?',
    "I'll be emailing Zack the details tonight.",
    'Can you get that published before Friday?',
    "I'll do the posting tonight.",
    'Mei, can you file a ticket for the counter cover plan?',
    'I, Booth Playtest, will post the agreed plan in the team channel today.',
    'I, Wei Ling, am going to email Zack tonight.',
    'Count on me to email Zack tonight.',
    'Leave it with me to post the update.',
    'I can handle sending that calendar invite.',
    'Sure, leave it to me.',
  ])('accepts an ordinary explicit assignment: %s', (line) => {
    expect(hasTaskAssignment(line)).toBe(true);
    expect(isHypotheticalProposal(line)).toBe(false);
  });

  it.each([
    'He will film an eight-thirty live re-taste tomorrow for six hundred cash, or four-fifty plus twenty plushies from our storeroom.',
    'I think we should take the four-fifty deal.',
    'We could post it next week.',
    'Sam Booth Playtest will post the agreed plan in the team channel today.',
    'I might post the agreed plan in the team channel today.',
    'I, Booth Playtest, think the agreed plan is good.',
  ])('rejects a quote or an option: %s', (line) => {
    expect(hasTaskAssignment(line)).toBe(false);
  });
});

describe('taskMatchesAssignment', () => {
  const lines = [
    { speaker: 'Mei', text: 'The butter plan needs a decision.' },
    { speaker: 'Wei Ling', text: "I'll email Zack tonight and confirm the details." },
    { speaker: 'Arjun', text: 'And I will post the final plan in the team channel.' },
  ];

  it('checks the evidence line, not the topic words of the lines around it', () => {
    expect(
      taskMatchesAssignment(
        { title: 'Post the butter plan in the team channel', context: 'Share the butter plan.' },
        lines[1]!,
        lines,
      ),
    ).toBe(false);
    expect(taskMatchesAssignment({ title: 'Email the butter supplier', context: 'Ask about butter.' }, lines[1]!, lines)).toBe(
      false,
    );
    expect(taskMatchesAssignment({ title: 'Email Zack to confirm the re-taste', context: '' }, lines[1]!, lines)).toBe(true);
  });

  it('does not let a title made only of generic action words through', () => {
    expect(taskMatchesAssignment({ title: 'Send the update', context: '' }, lines[1]!, lines)).toBe(false);
    expect(taskMatchesAssignment({ title: 'Post it', context: '' }, lines[1]!, lines)).toBe(false);
  });

  it('rejects a task about a different decision even when it shares the meeting vocabulary', () => {
    expect(
      taskMatchesAssignment(
        { title: 'Post the butter decision in the team channel', context: '' },
        { speaker: 'A', text: 'I will post the cash decision in the team channel today.' },
        [],
      ),
    ).toBe(false);
  });

  it('still accepts an anaphoric reference to the decision', () => {
    expect(
      taskMatchesAssignment(
        {
          title: 'Post the cash box decision in the team channel',
          context: 'Announce in the team channel today that we decided to move the cash box away from the food prep area.',
        },
        { speaker: 'Bao', text: 'Ada, can you post that decision in the team channel today so everyone has it?' },
        [],
      ),
    ).toBe(true);
  });
});

describe('isLikelyDuplicateQuestion', () => {
  it('catches the same question worded differently, but not a different one', () => {
    const open = ['When is the butter decision?'];
    expect(isLikelyDuplicateQuestion('When will the butter decision be made?', open)).toBe(true);
    expect(isLikelyDuplicateQuestion('How many solo diners need a table?', open)).toBe(false);
  });

  it('does not treat a short question as a repeat just because a long one contains "is it"', () => {
    const long = 'Do we know exactly where in level 5 players quit — is it the first rush, the second stall, or the end?';
    expect(isLikelyDuplicateQuestion(long, ['Is it the timer?'])).toBe(false);
    expect(isLikelyDuplicateQuestion('Is it the timer?', [long])).toBe(false);
  });

  it('still catches a reworded repeat of a short question', () => {
    expect(isLikelyDuplicateQuestion('Is the timer the cause?', ['Is it the timer?'])).toBe(true);
  });

  it('keeps distinct unknowns on one topic apart instead of merging them on shared words', () => {
    const cashOwner = 'Who runs the counter at 8?';
    const cashFloat = 'How is change counted and balanced at close?';
    const perHour = 'How many solo diners need a table between eight and ten?';
    expect(isLikelyDuplicateQuestion(cashFloat, [cashOwner])).toBe(false);
    expect(isLikelyDuplicateQuestion(cashOwner, [cashFloat])).toBe(false);
    expect(isLikelyDuplicateQuestion(perHour, [cashOwner])).toBe(false);
  });
});

describe('task agenda origin', () => {
  it('stamps a task with the agenda item the batch was sent on, not the index after the model replies', async () => {
    const { tasks, notetaker, setAgendaIndex } = setup((_messages) => {
      // The meeting moves on while the model is still thinking about the previous batch.
      setAgendaIndex(1);
      return reply({
        newTasks: [
          {
            title: 'Post the opening plan',
            context: 'Share the agreed opening plan with the team.',
            suggestedAssignee: 'producer',
            actionKind: 'mattermost_post',
            evidence: "Mei: I'll post the opening plan in the team channel today.",
          },
        ],
      });
    });

    notetaker.addChunk({ speaker: 'Mei', text: "I'll post the opening plan in the team channel today." });
    await notetaker.run();

    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]?.agendaItemTitle).toBe(scenario.agenda[0]?.title);
  });

  it('stamps a queued line with the agenda item it was heard on, not the one when run sends it', async () => {
    const { tasks, notetaker, setAgendaIndex } = setup(() =>
      reply({
        newTasks: [
          {
            title: 'Post the opening plan',
            context: 'Share the agreed opening plan with the team.',
            suggestedAssignee: 'producer',
            actionKind: 'mattermost_post',
            evidence: "Mei: I'll post the opening plan in the team channel today.",
          },
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Mei', text: "I'll post the opening plan in the team channel today." });
    // The meeting moves on before the queued line is analysed.
    setAgendaIndex(1);
    await notetaker.run();

    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]?.agendaItemTitle).toBe(scenario.agenda[0]?.title);
  });

  it('keeps a repeated handover on the agenda item of its unique decision source', async () => {
    const handover = 'Wei Ling, can you post this plan in Mattermost today?';
    const seatingPlan =
      'We will run the booth rule from 8 to 10:30 AM, the floor managers enforce it, and we measure table turnover every morning.';
    const regularsPlan =
      'We will add a regulars price on the till, keep the old kopi price explained at the counter, and Mei will test the rule tonight.';
    const { tasks, notetaker, setAgendaIndex } = setup(
      (_messages, call) =>
        call === 0
          ? reply({})
          : reply({
              newTasks: [
                {
                  title: 'Post the regulars price decision in Mattermost',
                  context: 'Share the regulars price decision with the team.',
                  suggestedAssignee: 'producer',
                  actionKind: 'mattermost_post',
                  evidence: handover,
                  decisionEvidence: regularsPlan,
                },
              ],
            }),
      1,
    );

    notetaker.addChunk({ speaker: 'Feifei Li', text: seatingPlan });
    notetaker.addChunk({ speaker: 'Wei Ling', text: handover });
    await notetaker.run();
    setAgendaIndex(0);
    notetaker.addChunk({ speaker: 'Arjun', text: regularsPlan });
    notetaker.addChunk({ speaker: 'Wei Ling', text: handover });
    await notetaker.run();

    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]).toMatchObject({
      suggestedAssignee: 'producer',
      decisionSource: regularsPlan,
      agendaItemTitle: scenario.agenda[0]?.title,
    });
  });

  it('keeps each task on the agenda item its own line was heard on in a mixed batch', async () => {
    const { tasks, notetaker, setAgendaIndex } = setup(() =>
      reply({
        newTasks: [
          {
            title: 'Post the opening plan',
            context: 'Share the agreed opening plan with the team.',
            suggestedAssignee: 'producer',
            actionKind: 'mattermost_post',
            evidence: "Mei: I'll post the opening plan in the team channel today.",
          },
          {
            title: 'Email the seating plan',
            context: 'Send the agreed seating plan to the team.',
            suggestedAssignee: 'producer',
            actionKind: 'email',
            evidence: "Daniel: I'll email the seating plan to the team tomorrow.",
          },
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Mei', text: "I'll post the opening plan in the team channel today." });
    setAgendaIndex(1);
    notetaker.addChunk({ speaker: 'Daniel', text: "I'll email the seating plan to the team tomorrow." });
    await notetaker.run();

    expect(tasks.list().map((task) => task.agendaItemTitle)).toEqual([
      scenario.agenda[0]?.title,
      scenario.agenda[1]?.title,
    ]);
  });
});

describe('grounded recovery from a verified assignment decision line', () => {
  const seatingPlan =
    'Final decision: we keep the seating plan that runs the booth rule from 8 to 10:30 AM, ' +
    'and I will post this plan in Mattermost today.';
  const acknowledgement = 'Since you are posting in Mattermost, no ticket is needed.';

  it('suggests the task from the visitor assignment when the model evidence is a nonassigning acknowledgement', async () => {
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          {
            title: 'Post the seating plan in Mattermost',
            context: 'Share the seating plan with the team.',
            suggestedAssignee: 'producer',
            actionKind: 'mattermost_post',
            evidence: acknowledgement,
            decisionEvidence: seatingPlan,
          },
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Feifei Li (Operations Director)', text: seatingPlan });
    notetaker.addChunk({ speaker: 'Mei', text: acknowledgement });
    await notetaker.run();

    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]).toMatchObject({
      title: 'Post the seating plan in Mattermost',
      suggestedAssignee: 'producer',
      actionKind: 'mattermost_post',
      decisionSource: seatingPlan,
      agendaItemTitle: scenario.agenda[0]?.title,
    });
  });

  it('does not recover when the verified decision line makes no assignment', async () => {
    const noPromise =
      'Final decision: we keep the seating plan that runs the booth rule from 8 to 10:30 AM.';
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          {
            title: 'Post the seating plan in Mattermost',
            context: 'Share the seating plan with the team.',
            suggestedAssignee: 'producer',
            actionKind: 'mattermost_post',
            evidence: acknowledgement,
            decisionEvidence: noPromise,
          },
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Feifei Li (Operations Director)', text: noPromise });
    notetaker.addChunk({ speaker: 'Mei', text: acknowledgement });
    await notetaker.run();

    expect(tasks.list()).toEqual([]);
  });

  it('does not recover a differently shaped deliverable from a promise to post in Mattermost', async () => {
    const { tasks, notetaker } = setup(() =>
      reply({
        newTasks: [
          {
            title: 'File the seating plan as a Gitea issue',
            context: 'Create a tracking issue for the seating plan.',
            suggestedAssignee: 'producer',
            actionKind: 'gitea_issue',
            evidence: acknowledgement,
            decisionEvidence: seatingPlan,
          },
        ],
      }),
    );

    notetaker.addChunk({ speaker: 'Feifei Li (Operations Director)', text: seatingPlan });
    notetaker.addChunk({ speaker: 'Mei', text: acknowledgement });
    await notetaker.run();

    expect(tasks.list()).toEqual([]);
  });
});
