import { fileURLToPath } from 'node:url';

/**
 * Load the repo-root `.env`, if there is one, before any module reads process.env.
 * Variables already set in the shell win over the file. Import this first.
 */
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
