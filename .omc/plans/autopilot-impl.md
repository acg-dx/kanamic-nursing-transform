# 实施计划: Kanamick RPA 自动化系统

## 任务列表

### T1: 项目初始化
- 初始化 npm 项目，安装依赖 (playwright, googleapis, @anthropic-ai/sdk, winston, node-cron, dotenv)
- 创建 tsconfig.json, .env.example, package.json

### T2: 核心模块 - 选择器引擎 + AI自愈
- selector-engine.ts: 选择器解析，支持 primary + fallback + AI修复
- ai-healing-service.ts: 截图 → 发送AI → 获取新选择器 → 验证 → 更新配置
- 选择器JSON配置文件

### T3: 核心模块 - 浏览器管理 + 重试
- browser-manager.ts: Playwright 浏览器生命周期管理
- retry-manager.ts: 指数退避重试逻辑
- logger.ts: 结构化日志

### T4: 服务层
- spreadsheet.service.ts: Google Sheets 读写
- kanamick-auth.service.ts: 登录认证

### T5: 工作流 - 转记（数据录入）
- transcription.workflow.ts: 从中间Sheet读取数据 → 输入到Kanamick → 状态回写

### T6: 工作流 - 削除（删除）
- deletion.workflow.ts: 从削除Sheet读取 → 在Kanamick中删除记录 → 状态回写

### T7: 工作流 - 同一建物管理
- building.workflow.ts: 读取设施数据 → 打开同一建物管理画面 → 选择设施 → 匹配添加用户

### T8: 入口 + 调度
- index.ts: 定时任务调度, 工作流编排

## 依赖关系
T1 → T2, T3 (并行) → T4 → T5, T6, T7 (并行) → T8
