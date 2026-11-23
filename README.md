# dsh-todo-discipline

[![test](https://github.com/Rayzenchen/dsh-todo-discipline/actions/workflows/test.yml/badge.svg)](https://github.com/Rayzenchen/dsh-todo-discipline/actions/workflows/test.yml)

> **任务功能增强** · [English](README.en.md)

让 DSH 的「任务」清单在**回合进行中**实时跟进，而不是收尾时一次性全标完成。

Host 半边，无 Client 半边、无自绘界面。实测 DSH 版本：`0.2.2-rc.5`。

## 安装

从 GitHub 安装（设置 → 插件，填入安装 spec）：

```
github:Rayzenchen/dsh-todo-discipline
```

已经用 `link:` 装在本地 profile 里的，**不要**再装 GitHub 这一份——那会变成两个包往组合里插同名的行。

本地开发装法：把插件目录以 `link:/绝对路径` 加进 profile 的 `dsh.profile.bundles` 与 `dependencies`，再在 profile 目录执行 `pnpm install`。Host 半边改动**必须重启 DSH** 才生效。

---

## 1. 痛点与诊断

**症状**：模型执行任务时几乎不更新任务列表；经常全部做完了才把整个列表标为完成。

**诊断**：问题不在 UI，也不在模型"不愿意"，而在**没有任何机制管这件事**。

| 环节 | 事实（已核） | 结论 |
|---|---|---|
| 工具 | `@deepseek-ai/dsh-tool-todo` 只有 `todo_write`（整表替换），**没有 `todo_read`**（全库搜 `todo_read` 命中 **0**） | 清单**只写不读** |
| 回执 | 成功只返回计数 `Updated todo list: N pending, …`，**不含清单内容** | 模型手里唯一的清单副本，是它自己那次调用的**参数**（留在历史里） |
| 状态 | `todo/write` 事件 → `todos` session 投影；`apply` 在 `turn/start` 时归零 | 清单是**回合内**作用域；投影只喂 UI |
| 渲染 | `dsh-client-ui-conversation` 里 `useProjection("todos")` | 中途调一次 `todo_write`，界面立刻更新 |
| 结论 | 没有任何一步会强迫模型重新面对清单 | 痛点纯在**模型行为侧** |

所以修的不是界面，是"让模型在干活过程中真的去写清单"。

---

## 2. 两条机制（都用官方现成扩展点）

| 强度 | 扩展点 | 模式 | 做法 | 官方先例 |
|---|---|---|---|---|
| **软** | `agent/pre-step` | waterfall | 模型**每次发起请求之前**，把一条 notice 追加进这一步的进入批次（`messages`） | `dsh-agent-instructions`、`dsh-hooks-claude-code`、`dsh-plan-mode`、goal driver |
| **硬** | `agent/turn-stopping` | serial | 回合即将关闭时（边界提交前 `await`）调 `agent.steer(...)`，**强制模型再走一步** | `@deepseek-ai/dsh-hooks-claude-code` 的 Stop 钩子 |

`tools/post-execute` 仍然监听，但**只数数**（距上次写清单跑了多少次工具调用），不注入任何东西——两个监听器因此不可能对同一时刻发两条提醒。

**为什么从"挂在工具结果上"搬到 `agent/pre-step`**

旧版挂在 `tools/post-execute` 上、返回 `additionalContexts`（与 `dsh-repeat-tool-reminder` 同法），按 3 / 6 / 10 三档触发，**过档之后对该版清单永久沉默**。两个后果：

- 拖过第 10 次工具调用的回合，再也收不到任何提醒——而那恰恰是最需要提醒的长回合；
- 某一步没调工具时，也没有任何机会提醒。

`agent/pre-step` 在**每一次模型请求之前**都会跑，与是否调工具无关；而且模型"正要决定下一步"的那一刻，就是提醒最该出现的位置。

两个事实支撑了挂载方式：

- **挂在 profile 根层就能收到 agent 作用域事件。** `scopeTarget` 的过滤器里 `if (tag === undefined) return true` —— 未打 scope 标签的监听器**全局**被接纳（事件沿作用域链**向上**流动，从不向下）。
- **所以不需要把行插进 `standard` 预设内部。** 顺带核实：`applyEntryPatches` 的 group-insert 只对带 `group: true` 的行生效，而 shipped 的 `preset-standard`（`@deepseek-ai/dsh-agent-preset`）没带该字段，那条路本来也走不通。

---

## 3. 触发逻辑

软提醒由"距上次 `todo_write` 已经跑了多少次工具调用"驱动：

| 条件 | 行为 |
|---|---|
| 清单为 `null`（从没建过） | 默认**不说**；`remindWhenNoList: true` 时在第 `noListThreshold` 次提醒，之后每 `noListThreshold` 次再提醒一次 |
| 清单全部 `completed` | 永远不提醒 |
| 距上次写清单 ≥ `reminderInterval` 次工具调用（默认 3） | 发一条 check-in，然后**持续重复：3、6、9、12……永不退休** |

check-in 的内容——**就一句话**：

```
Task list check-in: 6 tool calls since your last todo_write — update the list now to reflect what is finished.
```

**为什么提醒里不带清单**：模型每次写清单时，那份完整清单已经以"工具调用参数"的形式落在历史里了——它自己的动作已经让它看过一遍；`todos` 投影又把计划实时渲染给用户。在这里再抄一遍清单，等于用上下文把同一份信息买两次，而这条消息会进入历史并被**反复重发**。所以它只保留两样东西：**过了多久**（唯一的增量信息）和**该做什么**。

**去重与节流**：间隔判定用的是"**至少**过了 N 次"而不是"正好等于 N"——一步里并发跑多个工具可能跨过某个整数倍，跨过之后不该再推迟一整个间隔；同一个计数上重复触发 `pre-step` 也不会重复注入；每次 `todo_write` 把计数和"上次提醒位置"一起清零。

**收尾硬闸门**：`agent/turn-stopping` 时若清单仍有 `pending` / `in_progress`，就 steer 一条"要么做完、要么用 `todo_write` 把清单改成与实际一致"。

> **防循环**：官方 `dsh-hooks-claude-code` 在同样的位置留了一句 `TODO(stop-loop-guard): cap consecutive forced continuations`。本插件自带上限 `maxTurnEndSteers`（默认 **1**，每回合）——上限用完后即使清单仍不一致也放行，模型无视闸门也不会被无限 steer。

---

## 4. 配置

每个字段都有默认值，在 `cordis.patch.yml` 覆盖即可：

```yaml
- id: dsh-todo-discipline
  name: '@local/dsh-todo-discipline'
  config:
    reminderInterval: 5       # 越长越省上下文，越短提醒越密
    maxTurnEndSteers: 2       # 闸门每回合最多强制续跑几次
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时两个监听器都不注册 |
| `reminderInterval` | `3` | 距上次写清单多少次工具调用后提醒；**每满一次就再提醒一次，不会停** |
| `remindWhenNoList` | `false` | 连清单都没建时也提醒（默认关，因为痛点是"更新"不是"建表"） |
| `noListThreshold` | `8` | 上一条的首次触发次数，也是之后的重复间隔 |
| `gateOnTurnEnd` | `true` | 收尾硬闸门 |
| `maxTurnEndSteers` | `1` | 闸门每回合强制续跑上限（`0` = 关闭闸门） |
| `onlyRootAgents` | `true` | 只对 root agent 生效，**跳过子 agent**（避免在 128 路扇出里给每个子 agent 都加一次闸门延迟） |

> **配置键变更**：`nudgeThresholds` → `reminderInterval`、`nudgeWhenNoList` → `remindWhenNoList`；`nudgeWhenNoInProgress` / `flagMissingInProgress` 已**删除**（提醒改为一句话，不再单独提示"没有在办项"）。旧键**不会静默失效**——配置校验会 fail-loud 报 `unknown config key`。

配置**校验失败会 fail-loud**（未知键、类型错、越界都报 issue 并拒绝激活），避免 `cordis.patch.yml` 里写错一个键却静默无效。

---

## 5. 生效与自检

```bash
# 单元自检：78 项断言，对着真实 apply 跑（假 ctx 驱动真监听器）
node dsh-todo-discipline-plugin/tools/verify-core.mjs

# 语法与清单
node --check dsh-todo-discipline-plugin/index.js
```

自检里最要紧的一组断言是**"提醒永不退休"**：连续驱动 25 次工具调用，确认出声时点恰好是 **3、6、9、12、15、18、21、24**——这正是旧版 3/6/10 分档做不到的事（旧版在第 10 次之后就永久沉默了）。

安装后确认：

```bash
# 组合里的行与 profile 依赖
grep -n "todo-discipline" ~/.dsh/profiles/desktop/package.json

# 运行时是否挂上（走 Inspect，不需要审批）
#   cordis_inspect_query host/Config listConfigs name=@local/dsh-todo-discipline
```

**生效范围**：Host 半边改动**必须重启 DSH** 才生效（运行时代次是启动时加载的版本）；不重启时容易误判"改动无效"。这与本工作区其它插件的约定一致。

---

## 6. 已知边界

**1. 本插件 `import` 为空，这是刻意的。**

profile 里的插件是**符号链接**到本工作区的，Node 按真实路径向上解析 bare import —— 而工作区链路上没有任何 `@deepseek-ai/*` 包（已核实：profile 的 `node_modules` 只有 `@local/*` 链接）。所以 bare-import DSH 自身包会在运行时加载失败。插件本来要用的两样东西都按**文档化的形状**在本地复现：

- notice 消息：`createUserMessage(input)` 即 `deepFreeze(structuredClone({...input, id: randomUUID(), role:'user'}))`；生产者的 source 是 `{ kind, form:'notice', summary }`，summary 受 120 字符约束。`kind` 是**承重**的——未打标签的上下文在派生历史里会被渲染成用户提示。
- `Config`：实现为 **Standard Schema**（`Config['~standard'].validate`），也就是 cordis `resolveConfig` 真正调用的那个接口。

**2. 提醒会进入历史，代价随回合长度增长。**

`agent/pre-step` 返回的消息会成为这一步**durable** 的进入批次，之后每一步都随请求重发。所以提醒频率是靠"每条都很短"换来的——每条只有一句话（约 20 token），默认间隔 3 的总开销比旧版"三档 + 带清单"还低。**极长回合仍可把 `reminderInterval` 调大**（4～6）。它同时也会在界面上以 notice 行的形式出现。

**3. 代价**：因为它不是 Schemastery 图，DSH 的 config-schema 投影会把本行的 schema 标为 `status: "unsupported"`。**影响仅限于设置页不为这几个旋钮生成表单**；配置照旧从 `cordis.patch.yml` 读取并在本地 fail-loud 校验。这是任何不用 schemastery 的第三方插件都会得到的降级，不是错误。

**4. 只管"更新"，不管"建表"**：`remindWhenNoList` 默认关。若你希望多步任务**一开始就建表**，把它打开。

**5. 硬闸门会多花一次模型调用**：当模型带着未完成清单收尾时，会被强制再走一步（每回合至多 `maxTurnEndSteers` 次）。这是实时性的代价，可用 `gateOnTurnEnd: false` 关掉。

**6. 软提醒不强制**：它只是把清单摆到模型眼前，模型仍可以无视——这正是保留收尾硬闸门的原因。

---

## 7. 维护提醒

- 本插件的正确性依赖四个**未导出的内部形状**：`additionalContexts` 的语义、`agent/pre-step` 的 decision（`{ kind: 'enter', messages }`）、`agent.steer` 的存在、`todos` 投影键。DSH 升级后请重跑自检，并用 Inspect 核对：
  - `Event` → `agent/pre-step`、`agent/turn-stopping`、`tools/post-execute`
  - `Service` → `sessionProjections`（`snapshot(session, ['todos'])`）
- 0.2.2 起子代理判定改用 `agent.session.header.origin === 'subagent'`（旧的 `AgentRegistry.roots()` 已删除），投影读取改用 `snapshot`（旧的 `stateOf(session, key)` 已弃用）。
- `index.js` 里 `apply` 的三个监听器都是 `ctx.on`，随插件 fiber 自动注销。
- 每 agent 的计数存在 `WeakMap` 里，随 agent 回收。

---

## 8. 许可证

MIT © 2026 Rayzenchen，见 [LICENSE](LICENSE)。
