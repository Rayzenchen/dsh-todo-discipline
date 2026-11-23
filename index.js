/**
 * Host half of `@local/dsh-todo-discipline`.
 *
 * Purpose: make the model's task list — `todo_write` → the `todos` session
 * projection, which the Web UI renders live via `useProjection('todos')` —
 * track progress DURING a turn, instead of being rewritten once at the end.
 *
 * ## Why this is a plugin rather than a prompt tweak
 *
 * The shipped `todo_write` description already asks the model to "mark each todo
 * `completed` as soon as it is done", but nothing in the Harness enforces or
 * reminds. The tool is also write-only: there is no `todo_read`, and a
 * successful write answers with counts (`Updated todo list: N pending, …`), not
 * with the list. The model's only copy of the plan is the argument of its own
 * earlier `todo_write` call, still sitting in history. Nothing therefore ever
 * forces it to face the list again — which is exactly the failure this plugin
 * exists to prevent.
 *
 * ## Where the reminder rides, and why
 *
 * `agent/pre-step` is the waterfall the driver runs before EVERY model request:
 * the moment the model is about to choose its next move, whether or not that
 * move involves a tool. Its decision carries the entering `messages` batch, and
 * first-party plugins fold their own message in there the same way
 * (`dsh-agent-instructions`, `dsh-hooks-claude-code`, `dsh-plan-mode`, the goal
 * driver). This plugin appends one notice when the list has gone
 * `reminderInterval` tool calls without an update, and keeps doing so for as
 * long as the staleness lasts: **the reminder never retires**.
 *
 * The first version of this plugin instead attached a notice to tool RESULTS via
 * `tools/post-execute` (the mechanism `@deepseek-ai/dsh-repeat-tool-reminder`
 * uses), at three fixed tiers (3/6/10), and then went permanently silent for
 * that list revision. Two defects followed, and both are the reason for the
 * rewrite: a turn that ran past the last tier received no further reminders at
 * all — precisely the long turns that need them — and a step that ran no tools
 * received none either.
 *
 * `tools/post-execute` still listens, but only to count tool calls since the
 * last write. It injects nothing, so the two listeners can never double-remind
 * for the same moment.
 *
 * The turn-end gate stays on `agent/turn-stopping` (serial): a listener that
 * calls `agent.steer(...)` before the turn boundary commits forces another step.
 * That is the same mechanism as `dsh-hooks-claude-code`'s Stop hook, which ships
 * with a `TODO(stop-loop-guard)`, so this plugin caps its own forced
 * continuations per turn.
 *
 * Mounted as a normal profile row, the plugin's context is untagged, and
 * `scopeTarget`'s filter admits an untagged listener to every scope
 * (`if (tag === undefined) return true`), so agent-scoped events reach it.
 *
 * ## Cost, stated plainly
 *
 * A message appended at `agent/pre-step` becomes part of that step's durable
 * entering batch, so it stays in history and is re-sent with every later
 * request. Reminder density therefore costs context, and the honest trade is:
 * keep the notice short, and raise `reminderInterval` on long turns.
 *
 * ## Why this file imports nothing
 *
 * A profile bundle is symlinked into the profile from this workspace, so Node
 * resolves the plugin's own bare imports from the workspace upward — where no
 * `@deepseek-ai/*` package exists (the profile's `node_modules` holds only the
 * `@local/*` links). A bare import of a shipped package would therefore fail to
 * load at runtime. The two imports this plugin would otherwise use are
 * reproduced here, each to its documented shape:
 *
 *   - the notice message. `createUserMessage(input)` is
 *     `deepFreeze(structuredClone({ ...input, id: randomUUID(), role: 'user' }))`,
 *     and a producer's source is `{ kind, form: 'notice', summary }` with the
 *     summary bounded to `CONTEXT_SUMMARY_MAX_CHARS` (120). The `kind` label is
 *     load-bearing: an unlabeled context renders as a user prompt in derived
 *     history.
 *   - `Config`, as a Standard Schema object — the interface cordis's
 *     `resolveConfig` actually calls (`Config['~standard'].validate(value)`,
 *     synchronous, `{ value }` or `{ issues }`). It is deliberately NOT a
 *     Schemastery graph, so DSH's config-schema projector reports this row's
 *     schema as `unsupported`; the only effect is that the Settings UI renders
 *     no generated form for these knobs. They are still read from
 *     `cordis.patch.yml` and validated fail-loud below.
 */

/** Cordis plugin name; also the Loader row id in `cordis.patch.yml`. */
export const name = 'dsh-todo-discipline'

/**
 * The one service this plugin reads. Declared so the plugin stays inactive in a
 * composition without session projections instead of throwing. The `todos` unit
 * itself belongs to `@deepseek-ai/dsh-tool-todo`; when that plugin is absent the
 * snapshot carries no `todos` value and every listener here becomes a no-op.
 */
export const inject = ['sessionProjections']

/** Producer source stamped on every context this plugin injects. */
const SOURCE_KIND = 'dsh-todo-discipline'

/** The shipped bound on a `notice` summary; exceeding it is a contract violation, not a crash. */
const CONTEXT_SUMMARY_MAX_CHARS = 120

/** The model-facing tool whose call resets the staleness counter. */
const TODO_TOOL = 'todo_write'

/** Standard Schema interface key, read by cordis `resolveConfig`. */
const STANDARD_SCHEMA = '~standard'

/**
 * The tunable surface, with the default each field falls back to when the row's
 * `config` omits it. `kind` selects the check; `min` is the inclusive lower
 * bound for the numeric kinds.
 *
 * The keys were renamed (`nudgeThresholds` → `reminderInterval`) when the tiered
 * rule was replaced by a repeating one, and trimmed again when the check-in
 * became a single sentence and `flagMissingInProgress` was dropped. Stale keys
 * fail loudly rather than silently doing nothing, which is the whole point of
 * the fail-loud check below.
 */
const FIELDS = {
  /** Master switch: `false` removes both listeners without unloading the row. */
  enabled: { kind: 'boolean', fallback: true },
  /**
   * Tool calls since the last `todo_write` at which a reminder is due. Unlike
   * the tiers it replaced, this one repeats for as long as the list stays
   * stale: 3, 6, 9, … until the model writes a new list.
   */
  reminderInterval: { kind: 'integer', fallback: 3, min: 1 },
  /** Also remind when no list has been created at all; off by default, since the reported pain is updates, not creation. */
  remindWhenNoList: { kind: 'boolean', fallback: false },
  /** Tool calls without any `todo_write` at all before that reminder fires, and the spacing between its repeats. */
  noListThreshold: { kind: 'integer', fallback: 8, min: 1 },
  /** Gate the turn boundary on a consistent list. */
  gateOnTurnEnd: { kind: 'boolean', fallback: true },
  /**
   * Forced continuations per turn. The cap is the loop guard: once it is spent,
   * the turn closes even with an inconsistent list, so a model that ignores the
   * gate cannot be steered forever.
   */
  maxTurnEndSteers: { kind: 'integer', fallback: 1, min: 0 },
  /** Restrict both mechanisms to agents the registry owns no parent for, i.e. not subagents. */
  onlyRootAgents: { kind: 'boolean', fallback: true },
}

/** Field names, for the unknown-key check. */
const FIELD_NAMES = new Set(Object.keys(FIELDS))

/**
 * Validate one row's `config` against {@link FIELDS}, applying every default.
 *
 * Fail-loud, per the Harness convention: an unknown key or a wrongly typed
 * value is reported as an issue rather than silently ignored, because a typo in
 * `cordis.patch.yml` that quietly does nothing is the expensive failure.
 * @param input - the row's raw `config` value, possibly `undefined`.
 * @returns `{ value }` with every field defaulted, or `{ issues }`.
 */
function validateConfig(input) {
  const raw = input === undefined || input === null ? {} : input
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'config must be a mapping', path: [] }] }
  }
  const issues = []
  for (const key of Object.keys(raw)) {
    if (!FIELD_NAMES.has(key)) issues.push({ message: `unknown config key "${key}"`, path: [key] })
  }
  const value = {}
  for (const [key, spec] of Object.entries(FIELDS)) {
    const given = Object.hasOwn(raw, key) ? raw[key] : spec.fallback
    if (spec.kind === 'boolean') {
      if (typeof given !== 'boolean') issues.push({ message: `\`${key}\` must be a boolean`, path: [key] })
      else value[key] = given
      continue
    }
    if (!Number.isInteger(given) || given < spec.min) issues.push({ message: `\`${key}\` must be an integer >= ${spec.min}`, path: [key] })
    else value[key] = given
  }
  return issues.length > 0 ? { issues } : { value }
}

/** The row's Config, in the Standard Schema shape cordis reads. */
export const Config = {
  [STANDARD_SCHEMA]: {
    version: 1,
    vendor: 'dsh-todo-discipline',
    validate: validateConfig,
  },
}

/** Bound one notice summary the way the shipped producers do. */
function boundSummary(summary) {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * Build one notice message, to the shape `createUserMessage` produces.
 * @param text - the model-facing body.
 * @param summary - one-line account shown without expanding the row.
 * @returns the user-role message to inject.
 */
function notice(text, summary) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary: boundSummary(summary) },
  }
}

/** Render a task list for the model, one line per item. */
function renderList(todos) {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`).join('\n')
}

/**
 * The periodic check-in: one sentence, and deliberately no list.
 *
 * The list would be redundant. Whenever the model writes one, the whole list is
 * already in history as the arguments of that very `todo_write` call — its own
 * action has just put it there — and the `todos` projection re-renders the plan
 * in the UI for the user. Repeating it here would buy the same information twice
 * with context, and this message is committed to the step's entering batch and
 * re-sent with every later request, so it stays as short as the job allows: how
 * long it has been, and what to do about it.
 */
function checkInText(state) {
  return `Task list check-in: ${state.calls} tool calls since your last ${TODO_TOOL} — update the list now to reflect what is finished.`
}

/** The optional no-list notice: multi-step work with no plan on record. */
function noListText(calls) {
  return [
    `You have run ${calls} tool calls without creating a task list.`,
    `If this work is multi-step, create one with ${TODO_TOOL} now — one todo per concrete step — and keep it current as you work.`,
  ].join('\n')
}

/** The turn-end gate notice: the list contradicts the work about to be reported as finished. */
function gateText(unfinished) {
  return [
    `You are about to end the turn, but your task list still shows ${unfinished.length} unfinished item(s):`,
    renderList(unfinished),
    `Before you stop, either finish them, or — if they are no longer needed — update the list with ${TODO_TOOL} so it matches what you actually did. Do not end the turn with a task list that contradicts your work.`,
  ].join('\n')
}

/**
 * Install the listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - the row's config, already validated and defaulted by {@link Config}.
 */
export function apply(ctx, config) {
  if (!config.enabled) return

  /** Per-agent counters, dropped with the agent. */
  const states = new WeakMap()

  function stateOf(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = { calls: 0, lastRemindedCalls: 0, gateTurn: undefined, steers: 0 }
      states.set(agent, state)
    }
    return state
  }

  /** Whether this plugin manages the given agent under the current scope policy. */
  function tracked(agent) {
    if (!config.onlyRootAgents) return true
    try {
      // 0.2.2 removed `AgentRegistry.roots()`: runtime membership now lives on
      // the Session header, where delegated Agents are stamped `origin:'subagent'`.
      return agent?.session?.header?.origin !== 'subagent'
    } catch (error) {
      ctx.logger?.warn?.(`${name}: could not classify the agent, treating it as tracked: ${String(error)}`)
      return true
    }
  }

  /**
   * Read the calling agent's current task list.
   * @returns the list, `null` before the turn's first write, or `undefined` when no
   * unit is registered or the read failed — callers treat `undefined` as "not ours to manage".
   */
  function readTodos(agent) {
    const session = agent.session
    if (session === undefined) return undefined
    try {
      // `snapshot` is the current read path: the legacy `stateOf(session, key)`
      // form still works but is deprecated in 0.2.2 and warns once per key.
      // The `todos` unit is client-visible (`wire.view` is the identity), so the
      // snapshot carries it; an unregistered unit simply yields `undefined`.
      return ctx.sessionProjections.snapshot(session, ['todos']).values.todos
    } catch (error) {
      ctx.logger?.warn?.(`${name}: reading the todos projection failed: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Decide whether a reminder is due right now, and record it when one is.
   *
   * Spacing is measured in tool calls since the last `todo_write`, and it is
   * checked as "at least `interval` have passed", not as an exact value: a step
   * that runs several tools at once may skip over a multiple, and a skipped
   * reminder must not push the next one out by another full interval.
   * @returns the message to inject, or `undefined` for silence.
   */
  function due(agent, state) {
    const todos = readTodos(agent)
    if (todos === undefined) return undefined

    if (todos === null) {
      if (!config.remindWhenNoList) return undefined
      if (state.calls < config.noListThreshold) return undefined
      if (state.calls - state.lastRemindedCalls < config.noListThreshold) return undefined
      state.lastRemindedCalls = state.calls
      return notice(noListText(state.calls), `no task list after ${state.calls} tool calls`)
    }

    if (todos.every((todo) => todo.status === 'completed')) return undefined
    if (state.calls - state.lastRemindedCalls < config.reminderInterval) return undefined
    state.lastRemindedCalls = state.calls
    return notice(checkInText(state), `task list check-in after ${state.calls} tool calls`)
  }

  /**
   * Append one message to a step's entering batch without disturbing the rest of
   * the decision. Appending is what the shipped pre-step consumers do; the
   * claimed messages stay exactly where the driver put them.
   */
  function withMessage(decision, message) {
    if (!Array.isArray(decision.messages)) return decision
    return { ...decision, messages: [...decision.messages, message] }
  }

  // Counting only: this listener never injects, so a reminder can never be
  // delivered twice for one moment (once here, once at the next pre-step).
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next()
    const agent = exec.agent
    if (agent === undefined || !tracked(agent)) return downstream
    const state = stateOf(agent)
    if (exec.name === TODO_TOOL) {
      state.calls = 0
      state.lastRemindedCalls = 0
      return downstream
    }
    state.calls += 1
    return downstream
  })

  // The one delivery point: before every model request, stale list or not.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.signal?.aborted === true) return decision
    const agent = payload.agent
    if (agent === undefined || !tracked(agent)) return decision
    const message = due(agent, stateOf(agent))
    return message === undefined ? decision : withMessage(decision, message)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    if (!config.gateOnTurnEnd || !tracked(agent)) return
    // `steer` is on the live loop object; the public `Agent` type does not declare it.
    if (typeof agent.steer !== 'function') return
    const state = stateOf(agent)
    if (state.gateTurn !== turn) {
      state.gateTurn = turn
      state.steers = 0
    }
    if (state.steers >= config.maxTurnEndSteers) return
    const todos = readTodos(agent)
    if (todos === undefined || todos === null) return
    const unfinished = todos.filter((todo) => todo.status !== 'completed')
    if (unfinished.length === 0) return
    state.steers += 1
    agent.steer(notice(gateText(unfinished), `${unfinished.length} task(s) still unfinished at turn end`))
  })
}
