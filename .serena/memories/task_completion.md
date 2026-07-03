# 完成任务时的检查
- 相关包构建：至少运行受影响包的 `build`，必要时补 `pnpm build:release` 更新根 `dist/`。
- 相关回归：daemon 生命周期、CLI daemon 启动/恢复、MCP 入口回归应按需跑通。
- 如 `pnpm build` 的 turbo 聚合脚本异常，优先分别构建受影响包并记录结果。
- 汇报时注明实际运行过的构建/测试命令，以及是否存在未覆盖风险。