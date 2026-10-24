# Ownership

Two people build Kaki in parallel on top of this shared core.

| Owner | Folders |
|---|---|
| Host | `server/src/host/**` (including `host/index.ts`), `web/src/screen/**`, `scenarios/*/replay/` |
| Wingman | `server/src/wingman/**` (including `wingman/index.ts`), `web/src/phone/**`, `docker/`, `scenarios/*/seed/` |

## Shared: change only via a small reviewed PR

`shared/**`, `server/src/{app,index,env,hub,tasks,modules,loadScenario,llm}.ts`, `server/src/dev/**`,
`web/src/{App.tsx,main.tsx}`, `web/src/kaki/**`, `web/src/ui/**`, `scenarios/*/scenario.json`,
`scenarios/*/demo-events.json`, and root config files.

Raise a small PR and the other person reviews it within a day.

## Dependencies

Add a package in its own small commit (`package.json` plus lockfile only) so lockfile conflicts stay trivial.

## Rules

- The server decides who receives what; never the phone.
- Only the task store changes task state.
- Modules react to task changes through `tasks.onChange`; use `hub.subscribe` for other events. Plug in through your own `index.ts`.
- Prefer adding a new event or command over reshaping an existing one.
