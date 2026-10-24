/**
 * Run the scenario's replay through the notetaker with the real LLM and compare the result with
 * replay/expected.json. For tuning the prompt; needs KAKI_LLM_* (from .env or the shell).
 *
 *   npm run eval:notetaker            # EVAL_WINDOW_SECONDS=70 meeting seconds per pass (7 s at 10x)
 */
import '../env';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { KakiEvent, Role } from '@kaki/shared';
import type { Hub } from '../hub';
import { llmFromEnv } from '../llm';
import { loadScenario, scenarioDir, scenarioFolder } from '../loadScenario';
import { createTaskStore } from '../tasks';
import { createNotetaker } from './notetaker';
import { loadReplay } from './replay';

interface Expected {
  tasks: Array<{ name: string; assignee: Role; keywords: string[] }>;
  maxTasks: number;
  questions: Array<{ name: string; keywords: string[] }>;
  quietRoles: Role[];
}

const silentHub: Hub = {
  publish: (_event: KakiEvent) => {},
  subscribe: () => () => {},
  onCommand: () => {},
  close: () => {},
};

function mentionsAll(text: string, keywords: string[]): boolean {
  const haystack = text.toLowerCase();
  return keywords.every((keyword) => haystack.includes(keyword.toLowerCase()));
}

const llm = llmFromEnv();
if (llm === undefined) {
  console.error('Set KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL (in .env or the shell) first.');
  process.exit(2);
}

const windowSeconds = Number(process.env.EVAL_WINDOW_SECONDS ?? 70);
const folder = scenarioFolder();
const scenario = await loadScenario(folder);
const lines = await loadReplay(scenario, folder);
const expected = JSON.parse(
  await readFile(path.join(scenarioDir(folder), 'replay', 'expected.json'), 'utf8'),
) as Expected;

const tasks = createTaskStore({ hub: silentHub, scenario });
let agendaIndex = 0;
const notetaker = createNotetaker({ scenario, tasks, llm, agendaIndex: () => agendaIndex });

const started = Date.now();
let passes = 0;
for (let from = 0; from <= lines.at(-1)!.at; from += windowSeconds) {
  const batch = lines.filter((line) => line.at >= from && line.at < from + windowSeconds);
  if (batch.length === 0) continue;
  for (const line of batch) {
    agendaIndex = line.agendaIndex ?? agendaIndex;
    notetaker.addChunk(line);
  }
  await notetaker.run();
  passes += 1;
  const { status, lastError } = notetaker.state();
  if (status === 'stale') console.warn(`  pass ${passes} failed: ${lastError}`);
}
// Retry anything a failed pass left behind.
await notetaker.run();

const state = notetaker.state();
const found = tasks.list();
console.log(`\n${passes} passes in ${((Date.now() - started) / 1000).toFixed(1)} s, notetaker ${state.status}\n`);
console.log(`Tasks (${found.length}):`);
for (const task of found) console.log(`  - ${task.title} → ${task.suggestedAssignee} ${task.actionKind ?? '(manual)'}`);
console.log(`Open questions (${state.openQuestions.length}):`);
for (const question of state.openQuestions) console.log(`  - ${question.text} → ${question.forRole ?? '?'}`);
console.log(`Quiet roles: ${state.quietRoles.join(', ') || '(none)'}\n`);

const failures: string[] = [];
for (const want of expected.tasks) {
  const matches = found.filter(
    (task) => task.suggestedAssignee === want.assignee && mentionsAll(`${task.title} ${task.context}`, want.keywords),
  );
  if (matches.length === 0) failures.push(`missing task: ${want.name}`);
  if (matches.length > 1) failures.push(`duplicate task: ${want.name} (${matches.length}×)`);
}
if (found.length > expected.maxTasks) failures.push(`too many tasks: ${found.length} > ${expected.maxTasks}`);
for (const want of expected.questions) {
  if (!state.openQuestions.some((question) => mentionsAll(question.text, want.keywords))) {
    failures.push(`missing question: ${want.name}`);
  }
}
for (const role of expected.quietRoles) {
  if (!state.quietRoles.includes(role)) failures.push(`not flagged as quiet: ${role}`);
}

if (failures.length === 0) {
  console.log('PASS');
} else {
  console.log(`FAIL\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
  process.exitCode = 1;
}
