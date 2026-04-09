# brantrust — 低成本多模型会审器 MVP

## Context

用户在 Claude/Codex/Gemini 三套 CLI 中迭代出完整的"同题多模型融合协议"。但完整协议（两阶段 Judge + swap-compare）调用 9 次 API，成本高且维护重。

**核心判断**：完整协议是方法论目标，不是第一版执行成本。先做一个便宜、稳、能天天用的会审器。

## MVP 定义

**3×Generator + 1×Judge = 4 次 API 调用**

```
输入 → 并发生成(3) → 清洗归一化 → 单次Judge融合(1) → 输出+落盘
```

### 不进 V1
- 两阶段 Judge (A+B)
- swap-compare / 抗偏置
- thread / continue
- debate
- budget 调度器
- TUI / MCP / 数据库

### 代码结构预留
```js
runGenerators()       // V1 实现
normalizeResults()    // V1 实现
runSimpleJudge()      // V1 实现
runFullJudgePipeline() // V2 占位
writeRunArtifacts()   // V1 实现
```
CLI 预留 `--strict` 参数，当前返回 "planned for v2"。

## CLI 接口

```bash
brantrust "解释 CAP 定理"                    # 默认：3 generator + 1 judge
brantrust --no-judge "React vs Vue"          # 只并发收集
brantrust --judge-model gemini "数据库选型"   # 切换 Judge
brantrust --skip codex "量子计算"             # 跳过模型
cat app.ts | brantrust "review 这段代码"      # stdin 管道
brantrust --dir ~/project "项目分析"          # 工作目录
brantrust --timeout 60 "快速问题"             # 超时
brantrust --no-save "临时问答"                # 不保存
brantrust --json "问题"                       # JSON 输出
brantrust --list                              # 查看历史
brantrust --strict "关键决策"                 # V2: 完整 Judge 流水线
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `"prompt"` | 必须 | 问题 |
| `--skip <model>` | — | 跳过模型（可多次）|
| `--judge-model` | `claude` | Judge 模型 |
| `--no-judge` | false | 关闭 Judge |
| `--timeout` | 120 | 超时秒数 |
| `--dir` | cwd | 工作目录 |
| `--context-file` | — | 附加上下文 |
| `--no-save` | false | 不保存 |
| `--json` | false | JSON 输出 |
| `--list` | — | 查看历史 |
| `--strict` | — | V2 完整 Judge（暂未实现）|

## 实现细节

### Generator Dispatch

并发调用，`AbortController` 超时，`Promise.allSettled` 容错：

| Provider | 命令 | 提取字段 |
|----------|------|---------|
| Claude | `claude -p "$PROMPT" --output-format json --no-session-persistence` | `.result` |
| Codex | `codex exec "$PROMPT" --json --skip-git-repo-check --ephemeral` | JSONL → `item.completed` → `item.text` |
| Gemini | `gemini -p "$PROMPT" -o json` | 跳过 MCP 噪音前缀 → `.response` |

stderr 进度提示：`[Claude: 8.2s done] [Codex: running...] [Gemini: timeout]`

### Sanitize & Normalize

三个适配器各 ~20 行，降级策略：JSON → 正则 → fallback(截取末尾2000字符)

轻量归一化 schema（只提取 5 个核心字段）：
```json
{
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "content": "完整回答",
  "key_claims": ["结论1"],
  "assumptions": ["假设1"],
  "risks": ["风险1"],
  "uncertainty": ["不确定点1"],
  "duration_ms": 8234,
  "parse_mode": "json|jsonl|fallback",
  "error": null
}
```

### Simple Judge

**1 次调用**，Judge 只看归一化摘要（非全文），控制 token：

```
你是一个高级技术评审。三个 AI 模型对同一问题给出了各自的回答。

请输出：
1. 核心共识：各模型都认同的关键结论
2. 独特洞见：某个模型独有但有价值的见解
3. 分歧裁决：如果有矛盾，给出你的判断和理由
4. 集大成方案：综合最优的可执行方案
5. 风险提示：需要注意的假设和风险

问题：{prompt}

--- 候选 A ---
{normalized_summary_A}

--- 候选 B ---
{normalized_summary_B}

--- 候选 C ---
{normalized_summary_C}
```

Judge 调用时默认纯文本输出，但 prompt 内保留结构化段落模板（5 段固定标题），便于后续 V2 `--strict` 演进时切换为 JSON 解析。

### Output

**终端输出**：格式化 Markdown（各模型结果 + Judge 融合报告）

**落盘**（简化目录）：
```
~/ai-outputs/<timestamp>/
├── raw/
│   ├── claude.txt
│   ├── codex.txt
│   └── gemini.txt
├── normalized.json    # 三个 ProviderResult 数组
└── report.md          # 最终融合报告
```

`--list` 读取 `~/ai-outputs/` 下的目录列表展示历史。

### Token 控制硬规则

- Generator prompt 要求"简洁但完整"
- normalize 后只传摘要给 Judge（非全文原始输出）
- context-file 截断上限 8000 字符
- Judge prompt 精简，不做学术论文式长说明

### 成本估算

| 场景 | 调用次数 | 估算成本 |
|------|---------|---------|
| 简单问题 | 4 | $0.20 - 0.50 |
| 中等问题 | 4 | $0.50 - 1.00 |
| 复杂问题 | 4 | $1.00 - 2.00 |

## 文件变更

- **新建**: `~/.local/bin/brantrust` — Node.js 脚本，~250-350 行，零 npm 依赖
- **首次运行自动创建**: `~/ai-outputs/`
- **GitHub 仓库**: `brantrust`

## 验证方式

1. `brantrust "1+1等于几"` — 完整流程：3 generator + 1 judge + 报告
2. `brantrust --no-judge "hello"` — 只并发展示
3. `brantrust --skip codex "hello"` — 跳过
4. `echo "print('hello')" | brantrust "解释"` — stdin
5. `brantrust --dir /tmp "列出文件"` — 工作目录
6. `brantrust --json "test"` — JSON 输出
7. `brantrust --list` — 历史
8. `brantrust --timeout 5 "长文"` — 超时降级
9. `brantrust --strict "test"` — 返回 "planned for v2"
10. 检查 `~/ai-outputs/<timestamp>/` 含 raw/ + normalized.json + report.md

## V2 路线图

1. `--strict`: 两阶段 Judge (A+B) + swap-compare + 抗偏置
2. `--continue`: 线程续聊
3. `--context-file` 智能截断 + git diff 注入
4. 成本/token 预算控制器
5. 更多 provider（Goose、本地模型等）
