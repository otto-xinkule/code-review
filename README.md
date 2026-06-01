播放地址https://www.bilibili.com/video/BV1fxVo6ZEtF/?vd_source=c044e9fc1b540c5b4e2450454036571d

# AI PR Reviewer

AI 驱动的 Pull Request 代码审查工具，支持多模型、智能路由、上下文管理和反馈闭环。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置 .env（至少填入 GITHUB_TOKEN 和一个 AI API Key）
cp .env.example .env

# 3. 启动服务
npm run serve
```

打开 `http://localhost:3000`，输入仓库和 PR 编号即可开始审查。

## 功能特性

- **三入口** — CLI 命令行（`npm run dev`）、GitHub Actions（`npm run review:actions`）、Webhook 服务（`npm run serve`）
- **多模型支持** — Anthropic Claude / OpenAI GPT-4o / DeepSeek Coder / Qwen 2.5 Coder，支持智能路由和自动降级
- **智能审查** — 三个分析维d度：PR 变更总结、风险检测、改进建议
- **风险分级** — 按严重程度（严重/高/中/低）和类别（安全/性能/Bug/逻辑/可维护性）分类
- **上下文分层** — L1-L4 四级上下文深度，平衡准确率和 Token 成本
- **Web 仪表盘** — 审查指标、风险分布统计、审查历史记录
- **反馈闭环** — 问题/建议支持采纳/拒绝，数据驱动持续优化
- **离线可用** — 审查结果缓存，按 commit SHA 去重

## 架构

```
触发器（CLI / Actions / Webhook）
    │
    ▼
数据采集（GitHub API → Diff 解析 → 脱敏 → 上下文聚合）
    │
    ▼
分析引擎（变更总结 + 风险识别 + 建议生成）× 多模型路由
    │
    ▼
输出发布（校验 → 格式化 → PR 评论 + 行内评论）
    │
    ▼
前端仪表盘（总览 / 审查 / 配置 / 历史）
```

## 配置

| 环境变量 | 必填 | 默认值 | 说明 |
|---------|------|--------|------|
| `GITHUB_TOKEN` | 是 | - | GitHub 个人访问令牌 |
| `ANTHROPIC_API_KEY` | 至少一个 | - | Anthropic API Key |
| `OPENAI_API_KEY` | 至少一个 | - | OpenAI API Key |
| `DEEPSEEK_API_KEY` | 至少一个 | - | DeepSeek API Key |
| `QWEN_API_KEY` | 至少一个 | - | Qwen API Key |
| `GITHUB_REPOSITORY` | 否 | `""` | 默认仓库（owner/repo） |
| `WEBHOOK_SECRET` | 否 | - | Webhook 签名密钥 |
| `WEBHOOK_PORT` | 否 | `3000` | Webhook 服务端口 |
| `DEFAULT_MODEL` | 否 | `claude-opus-4-20240229` | 默认模型 |
| `FALLBACK_MODEL` | 否 | `gpt-4o` | 备选模型 |
| `ENABLE_MODEL_ROUTING` | 否 | `true` | 智能路由开关 |
| `TOKEN_BUDGET` | 否 | `8000` | 每次分析的 Token 预算 |
| `MAX_DIFF_SIZE` | 否 | `512000` | 最大 Diff 大小（字节） |
| `CONFIDENCE_THRESHOLD` | 否 | `0.7` | 最低置信度阈值 |
| `MIN_SEVERITY_LEVEL` | 否 | `medium` | 最低报告严重级别 |
| `LOG_LEVEL` | 否 | `info` | 日志级别 |
| `REQUEST_TIMEOUT` | 否 | `300000` | API 超时（毫秒） |
| `MAX_RETRIES` | 否 | `3` | 最大重试次数 |
| `CACHE_TTL_SECONDS` | 否 | `3600` | 缓存有效期（秒） |

功能开关：`ENABLE_SUMMARY`、`ENABLE_RISK_DETECTION`、`ENABLE_SUGGESTIONS`、`CHECK_SECURITY`、`CHECK_PERFORMANCE`、`CHECK_BUGS`、`CHECK_LOGIC`、`CHECK_MAINTAINABILITY`（均为 `true`/`false`）

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查（状态/队列/运行时间） |
| `GET` | `/metrics` | 审查指标（总数/成功率/耗时/Token） |
| `POST` | `/webhook` | GitHub Webhook 接收器 |
| `POST` | `/review` | 手动审查触发器，返回 taskId |
| `GET` | `/review/result?task={id}` | 轮询审查结果 |
| `GET` | `/review/history` | 审查历史列表 |
| `GET` | `/review/stats` | 风险分布统计 |
| `POST` | `/api/feedback` | 采纳/拒绝反馈 |
| `GET` | `/api/config` | 当前系统配置 |

## 前端页面

| 页面 | 功能 |
|------|------|
| **总览** | 审查指标卡片、风险分布统计（柱状图）、队列状态 |
| **审查 PR** | 输入仓库/PR 编号发起审查，实时轮询结果 |
| **审查结果** | 风险评分圈、问题列表（可筛选严重度/类别）、改进建议、采纳/拒绝按钮 |
| **配置** | 系统参数/模型状态/审查规则查看 |
| **历史** | 所有已完成审查记录，点击查看详情 |

## 模型对比

| 模型 | 代码理解 | 多文件 | 中文 | 成本（输入/输出每1M tokens） |
|------|---------|--------|------|---------------------------|
| Claude Opus 4 | 10 | 10 | 8 | $15.00 / $75.00 |
| GPT-4o | 8 | 8 | 7 | $5.00 / $15.00 |
| DeepSeek Coder | 7 | 7 | 9 | $0.14 / $0.28 |
| Qwen 2.5 Coder | 7 | 7 | 10 | $1.00 / $2.00 |

**路由策略**：正式发布 PR 用 Claude、快速审查用 DeepSeek、多语言用 GPT-4o、中文上下文用 Qwen。

## 部署方式

### Webhook 服务（推荐）

```bash
npm run serve
```

### GitHub Actions

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm install
      - run: npm run review:actions
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

### CLI 命令行

```bash
npm run dev review owner/repo 123
```

## 开发

```bash
npm run dev          # 开发模式启动
npm run build        # 编译 TypeScript
npm run test         # 运行测试
npm run lint         # 代码检查
npm run typecheck    # 类型检查
```

## 更新日志

详见 [CHANGELOG.md](../CHANGELOG.md)
