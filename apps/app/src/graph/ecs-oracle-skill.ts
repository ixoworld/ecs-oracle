/**
 * Inlined ecs-oracle skill metadata so the agent can skip `search_skills`
 * and `read_skill` round-trips. These two constants are what the agent
 * receives in its system prompt — no registry fetch at runtime.
 *
 * # Updating this file
 *
 * When you republish the ecs-oracle skill (its `cid` changes), do BOTH of:
 *
 * 1. Bump `ECS_ORACLE_SKILL_CID` below to the new CID returned by
 *    `publish_skill` (or visible in
 *    https://capsules.skills.ixo.earth/capsules/search?q=ecs-oracle).
 *
 * 2. Overwrite `ecs-oracle-skill.md` (sibling file in this folder) with
 *    the latest SKILL.md from
 *    `/Users/michael/dev/ixo/skills/skill-testing/skills/ecs-oracle/SKILL.md`.
 *    No escaping needed — the file is read verbatim at module load. Make
 *    sure to commit the new `.md` content alongside the CID bump so the
 *    two stay in sync.
 *
 * The `.md` file is copied into `dist/graph/` at build time by the
 * `assets` glob in `apps/app/nest-cli.json` (`"assets": ["**\/*.md"]`),
 * so it ships with the compiled JS in the Docker image. `__dirname`
 * resolves to `dist/graph` at runtime — same folder the asset lands in.
 *
 * If the `.md` file is missing the process fails to start with a clear
 * error rather than silently serving a stale or empty prompt — failing
 * loud at boot beats a confused agent at request time.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ECS_ORACLE_SKILL_CID =
  'QmeDjCrY7WbYsBPJvsokxMDL17me2iDisYVRntcNq8QTuK';

export const ECS_ORACLE_SKILL_MD = readFileSync(
  join(__dirname, 'ecs-oracle-skill.md'),
  'utf8',
);
