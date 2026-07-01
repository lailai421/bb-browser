# 风格与约定
- 交流、注释、文档优先使用中文；实现时保持现有 TypeScript/Node 代码风格。
- 修改文件时优先做小而明确的改动，避免回滚用户已有未提交改动。
- CLI / daemon / MCP 的公共接口名称保持兼容；共享协议类型在 `packages/shared/src/protocol.ts` 维护。
- 测试通常使用 `node:test` + `tsx`，集成测试大量依赖临时 `BB_BROWSER_HOME` 与 fake CDP 服务。