# 常用命令
- 构建包：`pnpm --filter @bb-browser/daemon build`、`pnpm --filter @bb-browser/cli build`、`pnpm --filter @bb-browser/mcp build`
- 根打包：`pnpm build:release`
- daemon 测试：`node .\\node_modules\\tsx\\dist\\cli.mjs --test packages/daemon/src/__tests__/daemon-lifecycle.test.ts`
- CLI 测试：`node .\\node_modules\\tsx\\dist\\cli.mjs --test packages/cli/src/__tests__/daemon-startup.test.ts`
- MCP 测试：`node --import tsx --test packages\\mcp\\src\\mcp.test.ts`
- 仓库脚本：`pnpm build`、`pnpm test`、`pnpm lint`
- Windows 检索：`rg -n <pattern>`、`rg --files <dir>`、`git status --short`