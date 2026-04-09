# brantrust

同题多模型融合器 — 把同一个问题同时发给 Claude、Codex、Gemini，然后用一个 Judge 综合出"集大成方案"。

```
输入 → 并发生成(3) → 清洗归一化 → Judge 融合(1) → 输出 + 落盘
```

4 次 API 调用，低成本，天天能用。

---

## 安装

```bash
# 克隆
git clone https://github.com/HongjieRen/brantrust.git
cd brantrust

# 软链接到 PATH
ln -sf "$(pwd)/brantrust" ~/.local/bin/brantrust
chmod +x brantrust
```

**前置依赖**（三个 CLI 均需已登录）：

| Provider | CLI | 验证命令 |
|----------|-----|---------|
| Claude | `claude` | `claude -p "hi" --output-format json` |
| OpenAI Codex | `codex` | `codex exec "hi" --json --skip-git-repo-check --ephemeral` |
| Google Gemini | `gemini` | `gemini -p "hi" -o json` |

---

## 用法

```bash
brantrust "解释 CAP 定理"                      # 默认：3 generator + 1 judge
brantrust --no-judge "React vs Vue"            # 只并发收集，不 judge
brantrust --judge-model gemini "数据库选型"    # 切换 Judge 模型
brantrust --skip codex "量子计算"              # 跳过某个模型（可多次）
cat app.ts | brantrust "review 这段代码"       # stdin 管道
brantrust --dir ~/project "项目分析"           # 指定工作目录
brantrust --context-file design.md "实现方案"  # 附加上下文文件
brantrust --timeout 60 "快速问题"              # 超时秒数
brantrust --no-save "临时问答"                 # 不保存到磁盘
brantrust --json "问题"                        # 输出完整 JSON
brantrust --list                               # 查看历史运行
brantrust --strict "关键决策"                  # [v2] 完整 Judge 流水线
```

### 参数一览

| 参数 | 默认 | 说明 |
|------|------|------|
| `"prompt"` | 必须 | 问题文本 |
| `--skip <model>` | — | 跳过模型：claude / codex / gemini，可多次使用 |
| `--judge-model <model>` | `claude` | Judge 使用的模型 |
| `--no-judge` | false | 关闭 Judge，只展示各模型原始回答 |
| `--timeout <sec>` | `120` | 每个模型的超时秒数 |
| `--dir <path>` | cwd | CLI 工具的工作目录 |
| `--context-file <file>` | — | 附加文件内容作为上下文（最多 8000 字符）|
| `--no-save` | false | 不保存结果到磁盘 |
| `--json` | false | 将完整结果以 JSON 格式输出到 stdout |
| `--list` | — | 列出最近 20 条历史运行 |
| `--strict` | — | [v2 占位] 两阶段 Judge + swap-compare |

---

## 输出

**终端**：各模型回答 + Judge 融合报告（Markdown 格式）

**落盘**（`~/ai-outputs/<timestamp>/`）：

```
~/ai-outputs/2026-04-09T11-23-45-678/
├── raw/
│   ├── claude.txt
│   ├── codex.txt
│   └── gemini.txt
├── normalized.json    # 三个模型的结构化摘要
└── report.md          # 最终融合报告
```

---

## 架构

```
runGenerators()         # 并发调用三个 CLI，AbortController 超时，Promise.allSettled 容错
normalizeResults()      # 各适配器提取 content / key_claims / assumptions / risks
runSimpleJudge()        # 单次 Judge 调用，只传归一化摘要（非全文），控制 token
writeRunArtifacts()     # 落盘 raw/ + normalized.json + report.md
runFullJudgePipeline()  # [v2 占位] 两阶段 Judge + swap-compare + 抗偏置
```

**Judge prompt 匿名化**：候选标签只用 A / B / C，不暴露 provider 名称，避免模型偏置。

---

## 成本估算

每次运行 = 4 次 API 调用（3 generator + 1 judge）：

| 问题复杂度 | 估算成本 |
|-----------|---------|
| 简单 | $0.20 – 0.50 |
| 中等 | $0.50 – 1.00 |
| 复杂 | $1.00 – 2.00 |

---

## V2 路线图

1. `--strict`：两阶段 Judge (A+B) + swap-compare + 抗偏置
2. `--continue`：线程续聊
3. `--context-file` 智能截断 + git diff 注入
4. 成本 / token 预算控制器
5. 更多 provider（Goose、本地模型等）
