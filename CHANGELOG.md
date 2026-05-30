# CHANGELOG

## [Unreleased] - master-zlx

### 新增反馈采纳/拒绝和置信度过滤 (45e528d)
- **后端**: 新增 `POST /api/feedback` 接口，记录每项 issue 级别的采纳/拒绝反馈
- **前端**: 审查结果每条问题/建议底部新增「采纳」「拒绝」按钮
  - 采纳后高亮蓝色，拒绝后半透明弱化
  - 点击实时调后端持久化，支持从历史记录中继续反馈
- **前端**: 新增审查结果筛选栏，按严重程度（严重/高/中/低）和类别（安全/性能/缺陷/逻辑/可维护性）过滤问题

### 新增审查历史、风险统计和 PR 摘要增强 (4779fa0)
- **后端**: 新增 `GET /review/history` 审查历史列表接口
- **后端**: 新增 `GET /review/stats` 风险分布聚合统计接口
- **前端**: 导航栏新增「历史」页面，展示所有已完成审查记录，支持点击查看详情
- **前端**: 仪表盘新增风险分布统计卡片（按严重程度柱状图 + 按类别柱状图）
- **前端**: PR 审查摘要增强（变更类型 badge、涉及模块、语言分布、关键文件）

### 环境配置与 gitignore (1a38860)
- 更新 .env 填入实际配置（GitHub Token、DeepSeek API Key）
- 默认模型切换为 deepseek-coder，关闭路由模式
- 新建 .gitignore 保护敏感文件

### 修复仪表盘指标不更新 (dcaa4fc)
- **后端**: 修复 `reviewPR` 成功/失败路径缺少 `metrics.recordReviewCompletion` 调用
- **前端**: 修复仪表盘字段名与 /metrics 接口不匹配（totalProcessed / averageDurationMs / tokensUsed.total）

### 接入真实审查结果，替换假数据 (42d5627)
- **后端**: `POST /review` 改为异步 task 模式，立即返回 taskId
- **后端**: 新增 `GET /review/result?task={id}` 轮询接口
- **前端**: 替换 `showDemoResult` 为真实轮询 + `renderReviewResult`
- **前端**: 渲染真实风险评分圈、问题列表（严重度/分类 badge + 文件位置）、改进建议

### 移除登录功能 (2598438)
- **前端**: 删除登录页 CSS、HTML 覆盖层、JS 登录/登出/验证码逻辑
- **后端**: 删除 auth Session/Cookie 存储、authGuard 中间件、4 个 API 路由
- 打开页面直接进入主界面，无需认证

### 初始化 (1261326 → fde069f)
- 初始项目搭建
- 手机号验证码登录功能（后被移除）
