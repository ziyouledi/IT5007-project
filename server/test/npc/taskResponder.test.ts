import { describe, expect, it, vi } from 'vitest';
import type { KakiCommand, KakiEvent, Task } from '@kaki/shared';
import { createTaskResponder, parseDecision } from '../../src/npc/taskResponder';
import { testScenario } from '../fixtures/scenario';

const chef = testScenario.attendees.find((a) => a.role === 'chef')!;
const scenario = {
  ...testScenario,
  npcs: [{ attendee: chef.name, voice: 'v', personality: 'Blunt.', agenda: 'Keep the oven safe.', concerns: ['fuses'] }],
};

function task(overrides: Partial<Task>): Task {
  return {
    id: 't-1',
    title: 'Fix the oven',
    context: 'Trips the fuse.',
    suggestedAssignee: 'chef',
    assignee: 'chef',
    status: 'DISPATCHED',
    ...overrides,
  } as Task;
}
const updated = (t: Task): KakiEvent => ({ type: 'TASK_UPDATED', payload: { task: t }, audience: { kind: 'screen' } });

type DecisionLine = { speaker: string; text: string; agendaItemTitle?: string };

function setup(
  reply: string | Error | Array<string | Error>,
  plays = true,
  draftOnly = false,
  volunteered = false,
  lines: DecisionLine[] = [],
) {
  const said: string[] = [];
  const sent: Array<[string, KakiCommand]> = [];
  let finish: ((spoken: boolean) => void) | undefined;
  let calls = 0;
  const prompts: string[] = [];
  const responder = createTaskResponder({
    scenario,
    llm: { complete: async (messages) => {
      const index = calls;
      calls += 1;
      prompts.push(messages.map((message) => message.content).join('\n'));
      const answer = Array.isArray(reply) ? reply[index] : reply;
      if (answer === undefined) throw new Error('unexpected extra model call');
      if (answer instanceof Error) throw answer;
      return answer;
    } },
    plays: () => plays,
    volunteeredOnTopic: () => volunteered,
    completedLinesOnTopic: () => lines,
    say: (_who, text, onDone) => { said.push(text); finish = onDone; },
    send: (role, command) => sent.push([role, command]),
    approveDelayMs: 20,
    draftOnly,
  });
  return { responder, said, sent, prompts, calls: () => calls, finish: (spoken = true) => finish?.(spoken) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('parseDecision', () => {
  it('needs a boolean and a spoken line', () => {
    expect(parseDecision('{"accept": false, "line": " No, too busy. "}')).toMatchObject({
      accept: false,
      line: 'No, too busy.',
    });
    expect(parseDecision('{"accept": "yes", "line": "ok"}')).toBeUndefined();
    expect(parseDecision('not json')).toBeUndefined();
  });

  it('numbers prior-commitment evidence from 1, matching the prompt', () => {
    expect(
      parseDecision('{"priorCommitment": true, "evidenceIndex": 1, "accept": true, "line": null}', true),
    ).toMatchObject({ priorCommitment: true, evidenceIndex: 1 });
    expect(
      parseDecision('{"priorCommitment": true, "evidenceIndex": 0, "accept": true, "line": null}', true),
    ).toBeUndefined();
  });
});

describe('task responder for an AI attendee', () => {
  it('gives the character their own facts to react from, and asks for a reaction before the decision', async () => {
    let prompt = '';
    const withFacts = {
      ...scenario,
      roles: scenario.roles.map((role) => (role.id === 'chef' ? { ...role, card: { youAre: 'You are the chef.', facts: ['The oven trips the fuse twice a week.'], responsibility: 'The kitchen.' } } : role)),
      agenda: [{ ...scenario.agenda[0]!, seatFacts: { chef: 'The current item has a late delivery.' } }],
    };
    const responder = createTaskResponder({
      scenario: withFacts,
      llm: { complete: async (messages) => { prompt = messages.map((m) => m.content).join('\n'); return '{"accept": true, "line": "ok"}'; } },
      plays: () => true,
      volunteeredOnTopic: () => false,
      say: () => undefined,
      send: () => undefined,
    });
    responder.handle(updated(task({ agendaItemTitle: 'Prep' })));
    await tick();
    expect(prompt).toContain('Things you know: The current item has a late delivery.');
    expect(prompt).not.toContain('The oven trips the fuse twice a week.');
    expect(prompt).toContain('concrete detail');
    expect(prompt).toContain('never ask a question');
  });

  it('never pulls a fact from an agenda item absent from this meeting', async () => {
    let prompt = '';
    const responder = createTaskResponder({
      scenario: { ...scenario, agenda: [{ ...scenario.agenda[0]!, seatFacts: { chef: 'present item fact' } }] },
      llm: { complete: async (messages) => { prompt = messages.map((m) => m.content).join('\n'); return '{"accept": true, "line": "I will take it."}'; } },
      plays: () => true, volunteeredOnTopic: () => false, say: () => undefined, send: () => undefined,
    });
    responder.handle(updated(task({ agendaItemTitle: 'Absent' })));
    await tick();
    expect(prompt).not.toContain('present item fact');
  });

  it('speaks first, then accepts, so the screen follows the words', async () => {
    const { responder, said, sent, finish } = setup('{"accept": true, "line": "Yes, I will fix it."}');
    responder.handle(updated(task({ actionKind: 'email' })));
    await tick();
    expect(said).toEqual(['Yes, I will fix it.']);
    expect(sent).toEqual([]);
    finish();
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'ACTION_AGENT' }]]);
  });

  it('claims by hand when the task has no action to run', async () => {
    const { responder, sent, finish } = setup('{"accept": true, "line": "On it."}');
    responder.handle(updated(task({})));
    await tick();
    finish();
    expect(sent[0]![1]).toMatchObject({ type: 'CLAIM_TASK', mode: 'MANUAL' });
  });

  it('declines when the character says no', async () => {
    const { responder, said, sent, finish } = setup('{"accept": false, "line": "Not mine, ask Ben."}');
    responder.handle(updated(task({})));
    await tick();
    finish();
    expect(said).toEqual(['Not mine, ask Ben.']);
    expect(sent).toEqual([['chef', { type: 'DECLINE_TASK', taskId: 't-1' }]]);
  });

  it.each([
    'I will fix the oven this afternoon.',
    "I'll fix the oven this afternoon.",
    "I'm going to fix the oven this afternoon.",
    'I, Ada, will fix the oven this afternoon.',
    'Sure, I will fix the oven this afternoon.',
  ])('honours an unchanged self-volunteered task silently, without asking the model: %s', async (quote) => {
    const { responder, said, sent, calls } = setup('{"accept": false, "line": "Not mine, ask Bao."}');
    responder.handle(
      updated(
        task({
          assignmentEvidence: {
            speaker: 'Ada (Chef)',
            quote,
            scope: { title: 'Fix the oven', context: 'Trips the fuse.' },
          },
        }),
      ),
    );
    await tick();
    expect(calls()).toBe(0);
    expect(said).toEqual([]);
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }]]);
  });

  it('does not claim from the old topic-wide flag alone; the exact task still goes to the model', async () => {
    const { responder, said, sent, calls, finish } = setup(
      '{"accept": false, "line": "That is not mine."}',
      true,
      false,
      true,
    );
    responder.handle(updated(task({})));
    await tick();
    expect(calls()).toBe(1);
    expect(said).toEqual(['That is not mine.']);
    finish();
    expect(sent).toEqual([['chef', { type: 'DECLINE_TASK', taskId: 't-1' }]]);
  });

  const commitment = 'I will fix the oven this afternoon.';
  const scope = { title: 'Fix the oven', context: 'Trips the fuse.' };
  const evidence = (quote: string, speaker = 'Ada (Chef)') => ({ speaker, quote, scope });
  it.each([
    ['no evidence', {}],
    ['a different speaker role', { assignmentEvidence: evidence(commitment, 'Bao (Cashier)') }],
    ['an invalid speaker', { assignmentEvidence: evidence(commitment, '  ') }],
    ['a negated commitment', { assignmentEvidence: evidence('I will not fix the oven this afternoon.') }],
    ['a refusal', { assignmentEvidence: evidence("No, I won't fix the oven this afternoon, but I will ask about it.") }],
    ['a conditional commitment', { assignmentEvidence: evidence('If approved I will fix the oven this afternoon.') }],
    ['a conditional clause after the commitment', { assignmentEvidence: evidence('I will fix the oven if approved.') }],
    ['a hypothetical commitment', { assignmentEvidence: evidence('Maybe I will fix the oven this afternoon.') }],
    ['a question', { assignmentEvidence: evidence('Do you think I will fix the oven this afternoon?') }],
    ['quoted speech', { assignmentEvidence: evidence('"I will fix the oven this afternoon."') }],
    ['reported speech', { assignmentEvidence: evidence('Ada said I will fix the oven this afternoon.') }],
    ['a delegated commitment', { assignmentEvidence: evidence('I will ask Bao to fix the oven this afternoon.') }],
    ['a changed title', { title: 'Replace the oven', assignmentEvidence: evidence(commitment) }],
    ['a changed context', { context: 'Trips the power.', assignmentEvidence: evidence(commitment) }],
    ['a changed action', { actionKind: 'email', assignmentEvidence: evidence(commitment) }],
  ] satisfies Array<[string, Partial<Task>]>)(
    'still leaves the decision to the character for %s', async (_label, overrides) => {
    const { responder, said, sent, calls, finish } = setup('{"accept": false, "line": "That is not mine."}');
    responder.handle(updated(task(overrides)));
    await tick();
    expect(calls()).toBe(1);
    expect(said).toEqual(['That is not mine.']);
    finish();
    expect(sent).toEqual([['chef', { type: 'DECLINE_TASK', taskId: 't-1' }]]);
    },
  );

  it('retries once, then returns the card unresolved instead of inventing an acceptance', async () => {
    const { responder, sent, said, calls, finish } = setup(new Error('timeout'));
    responder.handle(updated(task({})));
    await tick();
    expect(calls()).toBe(2);
    expect(said).toEqual([]);
    finish();
    expect(sent).toEqual([['chef', { type: 'RETURN_TASK_UNDECIDED', taskId: 't-1' }]]);
  });

  it('bounds each attempt with its own deadline', async () => {
    const sent: Array<[string, KakiCommand]> = [];
    let calls = 0;
    const responder = createTaskResponder({
      scenario,
      llm: {
        complete: (_messages, options) =>
          new Promise<string>((_resolve, reject) => {
            calls += 1;
            options?.signal?.addEventListener('abort', () => reject(new Error('deadline')));
          }),
      },
      plays: () => true,
      volunteeredOnTopic: () => false,
      completedLinesOnTopic: () => [],
      say: () => undefined,
      send: (role, command) => sent.push([role, command]),
      decisionDeadlineMs: 20,
    });

    responder.handle(updated(task({})));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(calls).toBe(2);
    expect(sent).toEqual([['chef', { type: 'RETURN_TASK_UNDECIDED', taskId: 't-1' }]]);
  });

  it('treats two invalid replies as an unreadable decision, never an acceptance', async () => {
    const { responder, sent, said, calls } = setup(['not json', '{"accept": "yes", "line": "ok"}']);
    responder.handle(updated(task({})));
    await tick();
    expect(calls()).toBe(2);
    expect(said).toEqual([]);
    expect(sent).toEqual([['chef', { type: 'RETURN_TASK_UNDECIDED', taskId: 't-1' }]]);
  });

  it('uses a valid reply after one failed attempt', async () => {
    const { responder, sent, said, calls, finish } = setup([
      new Error('timeout'),
      '{"accept": true, "line": "I will take it."}',
    ]);
    responder.handle(updated(task({})));
    await tick();
    expect(calls()).toBe(2);
    expect(said).toEqual(['I will take it.']);
    finish();
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }]]);
  });

  it('does not record an accept or decline when the spoken line was dropped', async () => {
    const { responder, sent, said, finish } = setup('{"accept": true, "line": "I will take it."}');
    responder.handle(updated(task({})));
    await tick();
    expect(said).toEqual(['I will take it.']);
    finish(false);
    expect(sent).toEqual([['chef', { type: 'RETURN_TASK_UNDECIDED', taskId: 't-1' }]]);
  });

  it('claims silently only when the model points at this attendee\'s own promise for this exact task', async () => {
    const promise = "I'll fix the oven this afternoon.";
    const { responder, sent, said, calls } = setup(
      '{"priorCommitment": true, "evidenceIndex": 1, "accept": true, "line": null}',
      true,
      false,
      false,
      [{ speaker: 'Ada (Chef)', text: promise, agendaItemTitle: 'Prep' }],
    );
    responder.handle(updated(task({ agendaItemTitle: 'Prep' })));
    await tick();
    expect(calls()).toBe(1);
    expect(said).toEqual([]);
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }]]);
  });

  it('reads the line the prompt numbered, not the array slot with the same index', async () => {
    const promise = "I'll fix the oven this afternoon.";
    const { responder, sent, prompts } = setup(
      '{"priorCommitment": true, "evidenceIndex": 1, "accept": true, "line": null}',
      true,
      false,
      false,
      [
        { speaker: 'Ada (Chef)', text: promise, agendaItemTitle: 'Prep' },
        { speaker: 'Bao (Cashier)', text: 'The sign is loose.', agendaItemTitle: 'Prep' },
      ],
    );
    responder.handle(updated(task({ agendaItemTitle: 'Prep' })));
    await tick();
    expect(prompts[0]).toContain(`1. Ada (Chef): ${promise}`);
    expect(prompts[0]).toContain('2. Bao (Cashier): The sign is loose.');
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }]]);
  });

  it('never lets one promise silently claim a different task for the same speaker', async () => {
    const promise = "I'll fix the oven this afternoon.";
    const { responder, sent, said, calls, finish } = setup(
      [
        '{"priorCommitment": true, "evidenceIndex": 1, "accept": true, "line": null}',
        '{"priorCommitment": false, "evidenceIndex": null, "accept": true, "line": "I will replace it."}',
      ],
      true,
      false,
      false,
      [
        { speaker: 'Ada (Chef)', text: promise, agendaItemTitle: 'Prep' },
        { speaker: 'Bao (Cashier)', text: 'The sign is loose.', agendaItemTitle: 'Prep' },
      ],
    );
    responder.handle(updated(task({ id: 't-1', agendaItemTitle: 'Prep' })));
    responder.handle(updated(task({ id: 't-2', title: 'Replace the oven', context: 'It is old.', agendaItemTitle: 'Prep' })));
    await tick();
    expect(calls()).toBe(2);
    expect(said).toEqual(['I will replace it.']);
    finish();
    expect(sent).toEqual([
      ['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }],
      ['chef', { type: 'CLAIM_TASK', taskId: 't-2', mode: 'MANUAL' }],
    ]);
  });

  it('rejects a promise on another agenda item or from another speaker, then leaves the card unresolved', async () => {
    const reply = '{"priorCommitment": true, "evidenceIndex": 1, "accept": true, "line": null}';
    for (const lines of [
      [{ speaker: 'Ada (Chef)', text: "I'll fix the oven this afternoon.", agendaItemTitle: 'Other' }],
      [{ speaker: 'Bao (Cashier)', text: "I'll fix the oven this afternoon.", agendaItemTitle: 'Prep' }],
    ]) {
      const { responder, sent, calls } = setup([reply, reply], true, false, false, lines);
      responder.handle(updated(task({ agendaItemTitle: 'Prep' })));
      await tick();
      expect(calls()).toBe(2);
      expect(sent).toEqual([['chef', { type: 'RETURN_TASK_UNDECIDED', taskId: 't-1' }]]);
    }
  });

  it('answers aloud when a task someone else handed over is wrongly claimed as a prior promise', async () => {
    // Alex handed Arjun the task; Arjun only said what he could do. The claim fails, the spoken answer stands.
    const { responder, sent, said, calls, finish } = setup(
      '{"priorCommitment": true, "evidenceIndex": 1, "accept": true, "line": "Sure, I\'ll open the ticket now."}',
      true,
      false,
      false,
      [{ speaker: 'Alex (Visitor)', text: 'Ada, please fix the oven.', agendaItemTitle: 'Prep' }],
    );
    responder.handle(updated(task({ agendaItemTitle: 'Prep' })));
    await tick();
    expect(calls()).toBe(1);
    expect(said).toEqual(["Sure, I'll open the ticket now."]);
    finish();
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }]]);
  });

  it('asks again without the claim when a failed prior promise came with nothing to say', async () => {
    const { responder, sent, said, prompts, finish } = setup(
      [
        '{"priorCommitment": true, "evidenceIndex": 1, "accept": true, "line": null}',
        '{"priorCommitment": false, "evidenceIndex": null, "accept": true, "line": "I will fix it."}',
      ],
      true,
      false,
      false,
      [{ speaker: 'Alex (Visitor)', text: 'Ada, please fix the oven.', agendaItemTitle: 'Prep' }],
    );
    responder.handle(updated(task({ agendaItemTitle: 'Prep' })));
    await tick();
    expect(prompts[0]).not.toContain('You did not promise this task yourself');
    expect(prompts[1]).toContain('You did not promise this task yourself');
    expect(said).toEqual(['I will fix it.']);
    finish();
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }]]);
  });

  it('does not silently claim when the task changed after the promise', async () => {
    const reply = '{"priorCommitment": true, "evidenceIndex": 1, "accept": true, "line": null}';
    const promise = "I'll fix the oven this afternoon.";
    const { responder, sent, said, calls } = setup([reply, reply], true, false, false, [
      { speaker: 'Ada (Chef)', text: promise, agendaItemTitle: 'Prep' },
    ]);
    responder.handle(
      updated(
        task({
          title: 'Replace the oven',
          agendaItemTitle: 'Prep',
          assignmentEvidence: {
            speaker: 'Ada (Chef)',
            quote: promise,
            scope: { title: 'Fix the oven', context: 'Trips the fuse.' },
          },
        }),
      ),
    );
    await tick();
    expect(calls()).toBe(2);
    expect(said).toEqual([]);
    expect(sent).toEqual([['chef', { type: 'RETURN_TASK_UNDECIDED', taskId: 't-1' }]]);
  });

  it('does not let a cut line the room never heard ground a silent claim', async () => {
    const reply = '{"priorCommitment": true, "evidenceIndex": 2, "accept": true, "line": null}';
    const { responder, sent, calls } = setup([reply, reply], true, false, false, [
      { speaker: 'Ada (Chef)', text: 'The sign is loose.', agendaItemTitle: 'Prep' },
    ]);
    responder.handle(updated(task({ agendaItemTitle: 'Prep' })));
    await tick();
    expect(calls()).toBe(2);
    expect(sent).toEqual([['chef', { type: 'RETURN_TASK_UNDECIDED', taskId: 't-1' }]]);
  });

  it('does not silently claim a conditional offer or a retraction the model rejects', async () => {
    const { responder, sent, said, finish } = setup(
      '{"priorCommitment": false, "evidenceIndex": null, "accept": true, "line": "I will take it."}',
      true,
      false,
      false,
      [{ speaker: 'Ada (Chef)', text: 'If approved I will fix the oven.', agendaItemTitle: 'Prep' }],
    );
    responder.handle(updated(task({ agendaItemTitle: 'Prep' })));
    await tick();
    expect(said).toEqual(['I will take it.']);
    finish();
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }]]);
  });

  it('answers a task once, but again if it is offered again after a decline', async () => {
    const { responder, said } = setup('{"accept": false, "line": "No."}');
    responder.handle(updated(task({})));
    responder.handle(updated(task({})));
    await tick();
    expect(said).toHaveLength(1);
    responder.handle(updated(task({ status: 'SUGGESTED', assignee: undefined })));
    responder.handle(updated(task({})));
    await tick();
    expect(said).toHaveLength(2);
  });

  it('approves the draft once it is ready, after a pause like a person reading it', async () => {
    const { responder, sent } = setup('{}');
    const draft = { target: 'a@b.c', subject: 's', body: 'b' };
    responder.handle(updated(task({ status: 'DRAFT_READY', draft })));
    responder.handle(updated(task({ status: 'DRAFT_READY', draft })));
    expect(sent).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sent).toEqual([['chef', { type: 'APPROVE_ACTION', taskId: 't-1', draft }]]);
  });

  it('in draftOnly mode still claims, but never auto-approves or retries a draft', async () => {
    vi.useFakeTimers();
    try {
      const { responder, sent, finish } = setup('{"accept": true, "line": "On it."}', true, true);
      const draft = { target: 'a@b.c', subject: 's', body: 'b' };
      responder.handle(updated(task({ status: 'DRAFT_READY', draft })));
      responder.handle(updated(task({ status: 'FAILED', draft, error: 'not sent' })));
      await vi.advanceTimersByTimeAsync(3_100);
      expect(sent).toEqual([]);

      responder.handle(updated(task({ actionKind: 'email' })));
      await vi.advanceTimersByTimeAsync(0);
      finish();
      expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'ACTION_AGENT' }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an ordinary failure automatically, but never one a restart interrupted', async () => {
    vi.useFakeTimers();
    try {
      const ordinary = setup('{}');
      ordinary.responder.handle(updated(task({ status: 'FAILED', error: 'not sent' })));
      await vi.advanceTimersByTimeAsync(3_100);
      expect(ordinary.sent).toEqual([['chef', { type: 'RETRY_ACTION', taskId: 't-1' }]]);

      const interrupted = setup('{}');
      interrupted.responder.handle(
        updated(task({ status: 'FAILED', interrupted: true, error: 'restarted' })),
      );
      await vi.advanceTimersByTimeAsync(3_100);
      expect(interrupted.sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the task alone when a person has taken that seat', async () => {
    const { responder, said, sent } = setup('{"accept": true, "line": "x"}', false);
    responder.handle(updated(task({})));
    responder.handle(updated(task({ status: 'DRAFT_READY', draft: { target: 't', subject: 's', body: 'b' } })));
    await tick();
    expect(said).toEqual([]);
    expect(sent).toEqual([]);
  });
});
