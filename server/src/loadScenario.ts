import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario, type Scenario } from '@kaki/shared';

const SCENARIOS_DIR = fileURLToPath(new URL('../../scenarios/', import.meta.url));
const FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The scenario folder selected with SCENARIO (default: pixel-kampung). */
export function scenarioFolder(): string {
  return process.env.SCENARIO ?? 'pixel-kampung';
}

/** The absolute path of scenarios/<name>/, rejecting anything that is not a plain folder name. */
export function scenarioDir(name: string): string {
  if (!FOLDER_PATTERN.test(name)) {
    throw new Error(`Invalid SCENARIO "${name}": expected a folder name such as "pixel-kampung"`);
  }
  return path.join(SCENARIOS_DIR, name);
}

/** Load and validate scenarios/<name>/scenario.json, failing loudly with the file path. */
export async function loadScenario(name = scenarioFolder()): Promise<Scenario> {
  const file = path.join(scenarioDir(name), 'scenario.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read scenario file ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Scenario file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  try {
    return parseScenario(json);
  } catch (error) {
    throw new Error(`Scenario file ${file} is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
