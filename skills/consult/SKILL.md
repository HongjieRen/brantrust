---
name: consult
version: 1.5.2
description: 在处理规划/设计/架构/调研类任务时，并发调用 codex + gemini + claude 获取多视角，主 Claude 担任 Judge 盲评综合输出。支持渐进式多轮对话和自动更新。
---

# consult — 多模型旁路军师

## Preamble（每次调用前先执行）

```bash
_REMOTE_VER=$(curl -sf --max-time 3 "https://raw.githubusercontent.com/HongjieRen/braintrust/main/skills/consult/SKILL.md" | awk '/^version:/ {print $2; exit}')
_LOCAL_VER=$(awk '/^version:/ {print $2; exit}' ~/.claude/skills/consult/SKILL.md 2>/dev/null)
[ -n "$_REMOTE_VER" ] && [ "$_REMOTE_VER" != "$_LOCAL_VER" ] && echo "UPGRADE_AVAILABLE $_LOCAL_VER $_REMOTE_VER" || echo "UP_TO_DATE $_LOCAL_VER"
```

**如果输出 `UPGRADE_AVAILABLE <old> <new>`**：静默自动更新，不打断用户：
```bash
cp ~/.claude/skills/consult/SKILL.md ~/.claude/skills/consult/SKILL.md.bak 2>/dev/null || true
curl -fsSL "https://raw.githubusercontent.com/HongjieRen/braintrust/main/skills/consult/SKILL.md" \
  -o ~/.claude/skills/consult/SKILL.md && echo "Updated consult skill $_old → $_new"
```
更新完成后继续执行本次任务，在最终回复末尾附一行：`*(consult skill 已自动更新 v{old} → v{new})*`

**如果输出 `UP_TO_DATE`**：直接继续，无需提示。  
**如果 curl 失败**：忽略，继续执行，不提示用户。

---

## 这是什么

`braintrust-lite` 提供的 MCP tool `mcp__braintrust_lite__consult` 会在后台并发调用 **Codex CLI**、**Gemini CLI** 和 **Claude CLI**，把三个顶尖模型的独立回答以匿名形式（Model A/B/C）交回给你。

你（主 Claude）负责担任 Judge——盲评内容，提炼共识、标注独特洞见、裁决分歧，输出集大成方案。

## 何时使用

对以下类型的任务，**在启动子 agent 的同时并行调用 consult**：

- 架构选型、技术选型、框架比较
- 方案设计（新功能、重大重构、系统集成）
- 复杂 bug 根因分析（多种假设并存时）
- 非显而易见的技术决策（有明显 trade-off 的场景）
- 安全或性能评审

## 何时跳过

- typo 修复、单行改动、简单 rename
- 只读信息查询（用 Grep / Read 就够）
- 用户已经明确指定方案，不需要二次意见
- 已知有标准答案的操作性任务

---

## 工作流：单轮

```
1. 发一条 message，同时 parallel call：
   ├─ Task(subagent_type=Plan/Explore/..., prompt=X)
   └─ mcp__braintrust_lite__consult(prompt=X, timeout_sec=<见下表>)

2. 等两者都返回后，你亲自担任 Judge（盲评流程）：

   步骤一：只看 Model A/B/C 内容，按结构完成评估（见下方 Judge 输出格式）

   步骤二：读 REVEAL 映射表

   步骤三：在回复末尾揭晓：
   "揭晓：Model A = Gemini，Model B = Claude，Model C = Codex"
```

### Judge 输出格式（必须分节，供多轮渐进加载）

每轮 Judge 输出**强制使用以下五节**，不可合并、不可省略：

```
### PERSPECTIVES
每个模型的核心立场，**逐模型列出**，不可合并，不可说"各模型均认为"：
- **Model A**：[该模型最核心的2-3个主张 / 独特视角，用具体措辞引用原文观点]
- **Model B**：[同上]
- **Model C**：[同上]

### VERDICT
<核心结论，1-3句。必须说明你采纳了哪个模型的哪个观点，以及理由>

### REASONING
<深度推理。强制要求：
 1. 至少引用2处模型间的具体分歧或差异（"Model A 认为X，Model B 认为Y，两者差异在于..."）
 2. 对每个关键判断说明为什么选A而不选B/C（不允许只说"综合来看"）
 3. 如果三模型观点一致，必须挖掘细节差异，或标注"三模型在X点上高度一致，其共同理由是...">

### TRADEOFFS
<权衡分析、已排除方案及理由，用户问"有没有其他方案"时加载>

### OPEN_QUESTIONS
<未解决的分歧或待确认的假设，用户问"还有什么不确定"时加载>
```

**PERSPECTIVES 的写法原则**：逐字从模型原文中提炼，不要意译或合并。如果 Model A 说"用 Redis 做 session"，就写"用 Redis 做 session"，不要写"推荐缓存方案"。

---

## 工作流：多轮对话（会话模式）

### 进入信号

`/consult` 触发后，第一轮回复顶部显示：

```
┌─ Consult 会话已启动 ──────────────────────────────┐
│ 模型：Codex · Gemini · Claude CLI                  │
│                                                    │
│ 退出会话：!done（或 !stop / 直接说"结束""退出"）   │
│ 切换记忆：!brief | !deep                           │
│ 查看原文：!deltas | !raw                           │
│                                                    │
│ ⚠ 注意：命令必须用 ! 开头，/done 会被 Claude Code  │
│   拦截为 skill 调用，Claude 永远看不到它。          │
└────────────────────────────────────────────────────┘
```

### 每轮状态栏（**每轮回复第一行**，始终显示）

每轮 Judge 输出**最开始**，必须先输出这一行状态栏，再输出任何正文：

```
[Consult·R{N} | 3 models | Consensus: {High/Split}]
```

- `R{N}` = 第几轮，帮助用户感知多轮积累
- `Consensus: Split` 时额外显示一行分歧摘要：`Note: split on <主要分歧点>`
- 平时无分歧则只显示 `High`，不展开
- 若模型降级（实际跑了少于 3 个），显示 `⚠ 2/3 models` 代替 `3 models`

### 多轮上下文：渐进式加载（核心设计）

**设计原则：不预先决定压缩多少，而是根据 follow-up 意图决定加载什么。**

每轮结束后维护一个**会话状态对象**（始终随 prompt 携带，~100 token）：

```
[Session State]
Goal: <用户核心目标>
Constraints: <已确认约束>
Decisions: <已做决策及理由>
Rejected: <已排除选项>
Open: <未解决问题>
Current best: <当前推荐方案一句话>
```

历史内容**按意图懒加载**，不机械按轮次：

| follow-up 意图 | 加载的历史内容 |
|---------------|--------------|
| 普通追问、深入某方向 | Session State + 所有历史 VERDICT |
| "为什么这样判断" | + 最近1轮 REASONING |
| "有没有其他方案" | + 最近1轮 TRADEOFFS |
| "还有什么不确定" | + 最近1轮 OPEN_QUESTIONS |
| "刚才某模型说的那个点" | + 按需检索原文片段（Model A/B/C 原始回答存档备查） |

历史 VERDICT 全部保留（每条 ~50 token），其余节只保留最近1-2轮，更老的丢弃。

### 自动降级

用户回复是简单确认时（"好的"、"谢谢"、"明白了"等），**不触发三模型并发**，由主 Claude 直接响应，节省成本和延迟。

判断标准：用户回复 < 20 字且不含实质性新问题。

### 多轮终止条件

- 用户输入 `!done` 或 `!stop`（`/done` 不可用，会被 Claude Code 拦截）
- 用户以自然语言表示结束：退出 / 结束 / 不用了 / 可以了 / 先这样 / exit / quit / stop / done / 好了 / 没问题了（判断需保守，模糊情况继续会话）
- 用户明确切换到与当前议题无关的新话题（仅在切换意图非常明确时触发，避免误判）
- 已进行 **4 轮**时，在状态栏后追加一行提示：`⚠ 本会话已进行 4 轮，再问一轮后将自动结束。输入 !done 立即退出，或继续追问。`
- 已进行 **5 轮**（自动退出）

退出时显示：`── Consult 会话结束（共 {N} 轮）──`

### 用户控制命令

**退出**
```
!done     退出 Consult 会话模式（主命令）
!stop     同上（别名，向后兼容）
```
⚠ 不要用 `/done`——`/` 前缀会被 Claude Code 拦截为 skill 调用，Claude 永远看不到。

**切换记忆模式**
```
!brief    精简记忆（只带 VERDICT，适合快速迭代）
!deep     完整记忆（带最近1轮 REASONING + TRADEOFFS，适合复杂设计）
```

**查看原文**
```
!deltas   展开本轮三模型核心主张各一句（不显示原文全文）
!raw      旁路展示本轮三模型原文（使用 REVEAL 映射表替换为真实模型名）。
          约束：① 不重新调用 consult，仅复用主 Claude 已持有的本轮回答；
                ② 不推进 R{N}，不更新 Session State，不写入 Decisions/Open；
                ③ 展示完即结束本次响应，下一轮 follow-up 仍按原 Session State 继续。
```

---

## consult tool 参数

```
prompt      (必须) 问题，建议精炼、自包含，含必要上下文
only        (可选) "codex" | "gemini" | "claude" — 只调用一个
skip        (可选) ["codex"] | ["gemini"] | ["claude"] — 跳过某个
timeout_sec (可选) 每个模型超时秒数，默认 90；传 0 = 不限时等待完成
blind       (可选) 默认 true；传 false 可直接看真实模型名称
show_raw    (可选) 默认 false；传 true = 直接展示三模型原始回答，跳过 Judge 融合
cwd         (可选) 子进程工作目录
```

**`show_raw: true` 使用场景**：终端 CLI 或独立一次性查询。  
**注**：主 Claude 在 `/consult` 多轮场景中**不要**主动设置 `show_raw: true`；用户想看原文时用 `!raw` 控制命令（旁路展示、不污染会话）。

## timeout 选择策略

**你（主 Claude）负责决定 timeout_sec：**

| 任务类型 | timeout_sec |
|---------|------------|
| 深度调研、市场分析、可行性研究 | **0**（不限时） |
| 架构设计、复杂方案对比 | **0**（不限时） |
| 代码审查、技术选型 | 180 |
| 简单问答、快速决策 | 90（默认） |

调研类任务一律传 `timeout_sec: 0`。

## 成本与延迟

- 每次 consult = 3 次 API 调用（codex + gemini + claude）
- 延迟 = `max(三者响应时间)`（并发）
- 简单问题 ~$0.05–0.20，中等 ~$0.20–0.50
- 自动降级（简单确认）= 0 次额外 API 调用

## 终端 fallback

```bash
consult "你的问题"
consult --only codex "快速问题"
consult --timeout 0 "深度调研问题"
consult --dir /your/project "review this project"
cat file.ts | consult "review this code"
```
