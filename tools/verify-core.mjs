/**
 * Self-check for `@local/dsh-todo-discipline`.
 *
 * Drives the REAL `apply` export through a fake Cordis context: the listeners
 * are registered exactly as the Loader would register them, then invoked with
 * the payload shapes the Harness dispatches. Nothing here re-implements the
 * plugin's decisions, so a passing run means the shipped code behaves.
 *
 * Two events matter. `tools/post-execute` is a waterfall that only counts tool
 * calls, and `agent/pre-step` is the waterfall that delivers the reminder into
 * the step's entering batch — the driver dispatches it as
 * `(payload, next)` where `next()` resolves to `{ kind: 'enter', messages }`.
 * The cadence tests therefore alternate the two, the way a real turn does.
 *
 * Agents are explicit: `makeCtx` hands back a `trackedAgents` list that answers
 * `agent.session.header.origin` (0.2.2 removed `AgentRegistry.roots()`). An
 * agent stamped `origin: 'subagent'` is how the `onlyRootAgents` cases are driven.
 *
 * Run: node dsh-todo-discipline-plugin/tools/verify-core.mjs
 */

import { apply, Config, inject, name } from '../index.js'

let passed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(label, a === e, `expected ${e}, got ${a}`)
}

function includes(label, haystack, needle) {
  check(label, typeof haystack === 'string' && haystack.includes(needle), `missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`)
}

function excludes(label, haystack, needle) {
  check(label, typeof haystack === 'string' && !haystack.includes(needle), `unexpected ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`)
}

/** Validate a raw config exactly as cordis's `resolveConfig` does. */
function configure(overrides = {}) {
  const result = Config['~standard'].validate(overrides)
  if (result.issues !== undefined) throw new Error(`config rejected: ${JSON.stringify(result.issues)}`)
  return result.value
}

function configIssues(overrides) {
  return Config['~standard'].validate(overrides).issues ?? []
}

/**
 * Build a fake context whose `sessionProjections.snapshot` answers the `todos`
 * unit, mirroring the real registry's `{ asOfSeq, values }` shape.
 */
function makeCtx({ todosFor = () => null } = {}) {
  const listeners = new Map()
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      const bucket = listeners.get(event) ?? []
      bucket.push(handler)
      listeners.set(event, bucket)
    },
    sessionProjections: {
      snapshot: (session, keys) => ({
        asOfSeq: 0,
        values: keys.includes('todos') ? { todos: todosFor(session) } : {},
      }),
    },
  }
  return { ctx, listeners }
}

/** A live agent whose Session header carries the runtime origin. */
function makeAgent({ session = { id: 's1' }, subagent = false, header = true } = {}) {
  const steers = []
  const withHeader = header ? { ...session, header: { origin: subagent ? 'subagent' : 'root' } } : session
  return { session: withHeader, steers, steer: (message) => steers.push(message) }
}

/** Invoke the registered post-execute listener and return the decision it produced. */
async function postExecute(listeners, exec, downstream = { kind: 'accept' }) {
  const [handler] = listeners.get('tools/post-execute') ?? []
  if (handler === undefined) throw new Error('no tools/post-execute listener registered')
  return await handler(exec, { kind: 'accept' }, async () => downstream)
}

/** Invoke the registered pre-step listener, as the driver dispatches it. */
async function preStep(listeners, payload, downstream = { kind: 'enter', messages: [] }) {
  const [handler] = listeners.get('agent/pre-step') ?? []
  if (handler === undefined) throw new Error('no agent/pre-step listener registered')
  return await handler({ signal: { aborted: false }, ...payload }, async () => downstream)
}

/** Invoke the registered turn-stopping listener. */
async function turnStopping(listeners, payload) {
  const [handler] = listeners.get('agent/turn-stopping') ?? []
  if (handler === undefined) throw new Error('no agent/turn-stopping listener registered')
  return await handler(payload)
}

/** Run one full cycle: a tool call lands, then the model proposes its next step. */
async function cycle(listeners, agent, toolName = 'read') {
  await postExecute(listeners, { name: toolName, agent })
  const decision = await preStep(listeners, { agent, messages: [] })
  return decision.messages.at(-1)
}

/** The text of the message a cycle injected, or `undefined` when it stayed silent. */
function injectedText(message) {
  return message?.content?.[0]?.text
}

const PENDING = [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]
const MIXED = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }]
const DONE = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }]

// ─── Config: defaults, normalization, fail-loud validation ────────────────────

{
  eq('config defaults', configure(), {
    enabled: true,
    reminderInterval: 3,
    remindWhenNoList: false,
    noListThreshold: 8,
    gateOnTurnEnd: true,
    maxTurnEndSteers: 1,
    onlyRootAgents: true,
  })
  eq('an explicit value wins over the default', configure({ reminderInterval: 5 }).reminderInterval, 5)
  eq('reminderInterval 1 is allowed', configure({ reminderInterval: 1 }).reminderInterval, 1)
  eq('unknown key is rejected', configIssues({ reminderIntervals: 3 }).length, 1)
  eq('the retired tier key is rejected, not silently ignored', configIssues({ nudgeThresholds: [3, 6, 10] }).length, 1)
  eq('the retired in-progress flag is rejected, not silently ignored', configIssues({ flagMissingInProgress: true }).length, 1)
  eq('wrong type is rejected', configIssues({ enabled: 'yes' }).length, 1)
  eq('reminderInterval below min is rejected', configIssues({ reminderInterval: 0 }).length, 1)
  eq('non-integer interval is rejected', configIssues({ reminderInterval: 2.5 }).length, 1)
  eq('negative integer is rejected', configIssues({ maxTurnEndSteers: -1 }).length, 1)
  eq('a scalar config is rejected', configIssues(7).length, 1)
  eq('plugin name', name, 'dsh-todo-discipline')
  eq('inject declares the projection registry', inject, ['sessionProjections'])
}

// ─── apply: the master switch ─────────────────────────────────────────────────

{
  const { ctx, listeners } = makeCtx()
  apply(ctx, configure({ enabled: false }))
  eq('enabled:false registers nothing', [...listeners.keys()], [])
}

// ─── The list is unknown to this plugin ──────────────────────────────────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => undefined })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  let last
  for (let i = 0; i < 12; i += 1) last = await cycle(listeners, agent)
  check('no todos unit → never injects', last === undefined)
  await turnStopping(listeners, { agent, turn: 1 })
  eq('no todos unit → never steers', agent.steers.length, 0)
}

// ─── The periodic check-in: fires at the interval, then keeps firing ──────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)

  const marks = []
  let lastInjected
  for (let i = 1; i <= 25; i += 1) {
    const message = await cycle(listeners, agent)
    if (message !== undefined) {
      marks.push(i)
      lastInjected = message
    }
  }

  // The defect the rewrite exists to fix: the old tiered rule fired at 3/6/10
  // and then never spoke again for that list revision.
  eq('the check-in fires on every interval past the old last tier, and never retires', marks, [3, 6, 9, 12, 15, 18, 21, 24])
  check('the last cycle of a 25-call run is correctly silent', injectedText(await cycle(listeners, agent)) === undefined)
  includes('the check-in names the count', injectedText(lastInjected), '24 tool calls since your last todo_write')
  includes('the check-in asks for the update', injectedText(lastInjected), 'update the list now to reflect what is finished')
}

// ─── Message shape ───────────────────────────────────────────────────────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  const injected = []
  for (let i = 1; i <= 15; i += 1) {
    const message = await cycle(listeners, agent)
    if (message !== undefined) injected.push(message)
  }
  const [first, , third] = injected
  eq('five reminders arrived in fifteen calls', injected.length, 5)

  eq('injected message is a user message', first.role, 'user')
  eq('injected message is labelled', first.source.kind, 'dsh-todo-discipline')
  eq('injected message declares the notice form', first.source.form, 'notice')
  check('injected message carries a summary', typeof first.source.summary === 'string' && first.source.summary.length > 0)
  check('the summary stays inside the shipped 120-char bound', first.source.summary.length <= 120)
  check('injected message carries a uuid id', /^[0-9a-f-]{36}$/.test(first.id))
  check('each reminder is a fresh message', first.id !== third.id)
}

// ─── The check-in is one sentence, and never the list ───────────────────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  let last
  for (let i = 1; i <= 3; i += 1) last = await cycle(listeners, agent)
  const text = injectedText(last)
  check('the check-in is a single line', text.split('\n').length === 1)
  excludes('it does not repeat the list', text, 'Current list:')
  excludes('nor any item line', text, '[pending] c')
  excludes('nor the in_progress tally', text, 'in_progress')
}

// ─── The counter resets on todo_write ────────────────────────────────────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  await cycle(listeners, agent)
  await cycle(listeners, agent)
  includes('a reminder fires before the write', injectedText(await cycle(listeners, agent)), '3 tool calls')

  await postExecute(listeners, { name: 'todo_write', agent })
  check('the write clears the pending reminder', injectedText(await cycle(listeners, agent)) === undefined)
  check('and the count really restarted', injectedText(await cycle(listeners, agent)) === undefined)
  includes('the next interval is measured from the write', injectedText(await cycle(listeners, agent)), '3 tool calls')
}

// ─── A finished list is never reminded ───────────────────────────────────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => DONE })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  let last
  for (let i = 0; i < 12; i += 1) last = await cycle(listeners, agent)
  check('an all-completed list is never reminded', last === undefined)
}

// ─── The optional no-list notice ─────────────────────────────────────────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => null })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  let last
  for (let i = 0; i < 9; i += 1) last = await cycle(listeners, agent)
  check('no list + remindWhenNoList off → silent', last === undefined)
}

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => null })
  apply(ctx, configure({ remindWhenNoList: true, noListThreshold: 4 }))
  const agent = makeAgent(trackedAgents)
  let third
  for (let i = 0; i < 3; i += 1) third = await cycle(listeners, agent)
  check('no-list notice stays silent below its threshold', third === undefined)
  includes('no-list notice fires at its threshold', injectedText(await cycle(listeners, agent)), 'without creating a task list')
  check('and it is not repeated on the very next call', injectedText(await cycle(listeners, agent)) === undefined)
  check('nor the one after', injectedText(await cycle(listeners, agent)) === undefined)
  check('nor the one after that', injectedText(await cycle(listeners, agent)) === undefined)
  includes('it repeats at twice the threshold instead of retiring', injectedText(await cycle(listeners, agent)), '8 tool calls')
}

// ─── post-execute counts but never injects ───────────────────────────────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => PENDING })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  const first = await postExecute(listeners, { name: 'read', agent })
  eq('post-execute injects no context', first.additionalContexts, undefined)

  const theirs = { id: 'x', role: 'user', content: [{ type: 'text', text: 'downstream' }], source: { kind: 'other' } }
  const downstream = { kind: 'accept', additionalContexts: [theirs] }
  const decision = await postExecute(listeners, { name: 'bash', agent }, downstream)
  eq('a downstream decision passes through untouched', decision, downstream)
}

// ─── pre-step plumbing ───────────────────────────────────────────────────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  await postExecute(listeners, { name: 'read', agent })
  await postExecute(listeners, { name: 'read', agent })
  await postExecute(listeners, { name: 'read', agent })

  const claimed = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'do the thing' }], source: { kind: 'user' } }
  const downstream = { kind: 'enter', messages: [claimed], assembly: { marker: true } }
  const decision = await preStep(listeners, { agent, messages: [claimed] }, downstream)
  eq('the claimed message keeps its place', decision.messages[0], claimed)
  eq('our reminder is appended after it', decision.messages.length, 2)
  eq('and it is ours', decision.messages[1].source.kind, 'dsh-todo-discipline')
  eq('the rest of the decision survives', decision.assembly, { marker: true })
  eq('the decision keeps its kind', decision.kind, 'enter')
}

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  await postExecute(listeners, { name: 'read', agent })
  await postExecute(listeners, { name: 'read', agent })
  await postExecute(listeners, { name: 'read', agent })

  const rejected = { kind: 'reject' }
  eq('a rejected step is left alone', await preStep(listeners, { agent, messages: [] }, rejected), rejected)

  const aborted = await preStep(listeners, { agent, messages: [], signal: { aborted: true } })
  eq('an aborted step is left alone', aborted, { kind: 'enter', messages: [] })

  const noMessages = { kind: 'enter' }
  eq('a decision without messages is left alone', await preStep(listeners, { agent }, noMessages), noMessages)

  const anonymous = await preStep(listeners, { messages: [] })
  eq('a payload without an agent is left alone', anonymous, { kind: 'enter', messages: [] })
}

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  for (let i = 0; i < 6; i += 1) await postExecute(listeners, { name: 'read', agent })
  const first = await preStep(listeners, { agent, messages: [] })
  const second = await preStep(listeners, { agent, messages: [] })
  eq('two pre-steps on the same count do not double-remind', first.messages.length, 1)
  eq('the second one is silent', second.messages.length, 0)
}

// ─── The turn-end gate ──────────────────────────────────────────────────────

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)

  await turnStopping(listeners, { agent, turn: 1 })
  eq('an unfinished list steers once', agent.steers.length, 1)
  includes('the gate names the unfinished item', agent.steers[0].content[0].text, '[pending] c')
  includes('the gate offers the reconcile option', agent.steers[0].content[0].text, 'update the list with todo_write')
  eq('the gate message is labelled', agent.steers[0].source.kind, 'dsh-todo-discipline')
  eq('the gate message declares the notice form', agent.steers[0].source.form, 'notice')

  await turnStopping(listeners, { agent, turn: 1 })
  eq('the cap holds within one turn', agent.steers.length, 1)

  await turnStopping(listeners, { agent, turn: 2 })
  eq('a new turn re-arms the gate', agent.steers.length, 2)
}

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure({ maxTurnEndSteers: 2 }))
  const agent = makeAgent(trackedAgents)
  await turnStopping(listeners, { agent, turn: 1 })
  await turnStopping(listeners, { agent, turn: 1 })
  await turnStopping(listeners, { agent, turn: 1 })
  eq('maxTurnEndSteers:2 allows two steers then stops', agent.steers.length, 2)
}

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => DONE })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  await turnStopping(listeners, { agent, turn: 1 })
  eq('a finished list never gates', agent.steers.length, 0)
}

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => null })
  apply(ctx, configure())
  const agent = makeAgent(trackedAgents)
  await turnStopping(listeners, { agent, turn: 1 })
  eq('no list never gates', agent.steers.length, 0)
}

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure({ gateOnTurnEnd: false }))
  const agent = makeAgent(trackedAgents)
  await turnStopping(listeners, { agent, turn: 1 })
  eq('gateOnTurnEnd:false disables the gate', agent.steers.length, 0)
}

{
  const { ctx, listeners, trackedAgents } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure({ maxTurnEndSteers: 0 }))
  const agent = makeAgent(trackedAgents)
  await turnStopping(listeners, { agent, turn: 1 })
  eq('maxTurnEndSteers:0 disables the gate', agent.steers.length, 0)
}

{
  const { ctx, listeners } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const agent = { session: { id: 's1' } } // no steer method, and not a tracked root
  await turnStopping(listeners, { agent, turn: 1 })
  check('an agent without steer does not crash the gate', true)
}

// ─── Scope policy ───────────────────────────────────────────────────────────

{
  const { ctx, listeners } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  const root = makeAgent({ session: { id: 'root' } })
  const child = makeAgent({ session: { id: 'child' }, subagent: true })

  let childDecision
  for (let i = 0; i < 12; i += 1) {
    await postExecute(listeners, { name: 'read', agent: child })
    childDecision = await preStep(listeners, { agent: child, messages: [] })
  }
  eq('a subagent is not reminded by default', childDecision.messages.length, 0)

  await turnStopping(listeners, { agent: child, turn: 1 })
  eq('a subagent is not gated by default', child.steers.length, 0)

  let rootDecision
  for (let i = 0; i < 3; i += 1) {
    await postExecute(listeners, { name: 'read', agent: root })
    rootDecision = await preStep(listeners, { agent: root, messages: [] })
  }
  eq('a root agent is reminded', rootDecision.messages.length, 1)

  await turnStopping(listeners, { agent: root, turn: 1 })
  eq('a root agent is gated', root.steers.length, 1)
}

{
  const { ctx, listeners } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure({ onlyRootAgents: false }))
  const child = makeAgent({ session: { id: 'child' }, subagent: true })
  for (let i = 0; i < 3; i += 1) await postExecute(listeners, { name: 'read', agent: child })
  const decision = await preStep(listeners, { agent: child, messages: [] })
  eq('onlyRootAgents:false reminds subagents too', decision.messages.length, 1)
  await turnStopping(listeners, { agent: child, turn: 1 })
  eq('onlyRootAgents:false gates subagents too', child.steers.length, 1)
}

{
  const { ctx, listeners } = makeCtx({ todosFor: () => MIXED })
  apply(ctx, configure())
  // No header at all (older Session formats): treat the agent as a root agent.
  const agent = makeAgent({ header: false })
  for (let i = 0; i < 3; i += 1) await postExecute(listeners, { name: 'read', agent })
  eq('a Session without a header origin still counts as root', (await preStep(listeners, { agent, messages: [] })).messages.length, 1)
  await turnStopping(listeners, { agent, turn: 1 })
  eq('a Session without a header origin is still gated', agent.steers.length, 1)
}

// ─── Report ─────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} of ${passed + failures.length} assertions failed:`)
  for (const failure of failures) console.error(`  · ${failure}`)
  process.exit(1)
}
console.log(`PASS — ${passed} assertions`)
