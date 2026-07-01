# bb-browser 项目概览
- 目的：提供一个通过 CLI / daemon / MCP 控制 Chrome 的浏览器自动化工具，支持标签页操作、页面观测、调试命令和 site adapter。
- 技术栈：TypeScript、Node.js、pnpm workspace、tsup、turbo、ws、Model Context Protocol SDK。
- 主要结构：`packages/cli` 为命令行入口，`packages/daemon` 为 CDP daemon，`packages/mcp` 为 MCP 服务，`packages/shared` 为共享协议与工具。
- 运行模式：CLI 通过 HTTP 调 daemon；daemon 直接连 Chrome CDP；MCP 通过 CLI/daemon 暴露 browser tools。