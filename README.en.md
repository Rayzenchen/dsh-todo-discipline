# dsh-todo-discipline

[![test](https://github.com/Rayzenchen/dsh-todo-discipline/actions/workflows/test.yml/badge.svg)](https://github.com/Rayzenchen/dsh-todo-discipline/actions/workflows/test.yml)

> **Task enhancement** · [中文](README.md)

Keeps the model's task list current *during* a turn, instead of being rewritten once at the end.

A DeepSeek Harness (`dsh`) plugin. Host-only bundle: no client code, no UI of its own.

---

## The gap

The shipped `todo_write` tool only writes. Its description already asks the model to "mark each todo
`completed` as soon as it is done", but nothing enforces it, nothing reminds, and there is no
`todo_read` — a successful write answers with counts, not with the list. The model's only copy of the
plan is the argument of its own earlier call, still sitting in history. In practice the list often gets
rewritten once, at the end, after the work is already done.

## Two mechanisms

| Layer | Extension point | What it does |
|---|---|---|
| Soft | `agent/pre-step` (waterfall) | Before **every** model request, if the list has gone `reminderInterval` tool calls (default 3) without an update, append one short notice to the step's entering batch. It repeats for as long as the list stays stale — 3, 6, 9, … — and never retires. It deliberately does **not** repeat the list: the model's own write already put it in history, and the notice is re-sent with every later request. |
| Hard | `agent/turn-stopping` (serial) | If the turn is about to close while the list still shows unfinished items, `agent.steer(...)` forces one more step that either finishes them or rewrites the list to match what actually happened. Capped at `maxTurnEndSteers` (default 1) per turn, so a model that ignores it cannot be steered forever. |

`tools/post-execute` also listens, but only to count tool calls since the last write; it injects nothing,
so the two layers can never double-remind for the same moment. Subagents are skipped by default
(`onlyRootAgents`), which keeps large workflow fan-outs free of extra gates.

## Install

From GitHub, in **Settings → Plugins** use the install spec:

```
github:Rayzenchen/dsh-todo-discipline
```

If the plugin is already installed from this checkout with a `link:` dependency, do **not** install the
GitHub copy as well — that would give the profile two packages inserting the same row.

For local development, add it to a profile's `dsh.profile.bundles` and `dependencies` as
`link:/absolute/path/to/dsh-todo-discipline-plugin`, then run `pnpm install` in the profile.

**Restart DSH after changing Host-side code** — the running generation is the one loaded at boot.

## Configuration

Every knob has a default. Override `config` on the row in the plugin's `cordis.patch.yml` (the whole
config is replaced, not deep-merged):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` registers neither listener. |
| `reminderInterval` | `3` | Tool calls since the last `todo_write` before a check-in; repeats every time it is reached. |
| `remindWhenNoList` | `false` | Also remind when no list has ever been created. |
| `noListThreshold` | `8` | Tool calls without any write before that reminder fires, and its repeat spacing. |
| `gateOnTurnEnd` | `true` | The turn-boundary gate. |
| `maxTurnEndSteers` | `1` | Forced continuations per turn (`0` disables the gate). |
| `onlyRootAgents` | `true` | Skip subagents. |

Unknown keys, wrong types and out-of-range values fail loudly at load time instead of silently doing
nothing.

## Known limits

- **It only keeps lists current; it does not create them.** `remindWhenNoList` is off by default, so a
  turn where the model never writes a list is not nudged.
- **The soft layer only advises.** The model can ignore it; that is why the turn-end gate exists.
- **The gate costs one extra model call** when it fires, and the reminder lines stay in history and are
  re-sent with each later request. Raise `reminderInterval` on very long turns.
- This plugin depends on internal, undocumented shapes (`agent/pre-step` decisions, `agent.steer`, the
  `todos` session projection, `agent.session.header.origin`). Re-run the self-test and check those with
  Inspect after every DSH upgrade.
- Because its `Config` is a Standard Schema object rather than a Schemastery graph, the Settings UI shows
  no generated form for these knobs; they are read from `cordis.patch.yml`.

## Compatibility

Built and verified against **DSH `0.2.2-rc.5`** (macOS desktop profile). No `peerDependencies` are
declared on purpose: this plugin talks to internal extension points, and pinning a DSH version would make
every DSH upgrade an install blocker instead of a self-test failure.

## Tests

```bash
node --check index.js
node tools/verify-core.mjs   # 78 assertions against a fake ctx driving the real listeners
```

## License

MIT © 2026 Rayzenchen — see [LICENSE](LICENSE).
