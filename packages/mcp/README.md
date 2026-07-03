# @wanji/bb-browser-mcp

MCP server for `bb-browser`.

Recommended config:

```json
{
  "mcpServers": {
    "bb-browser": {
      "command": "npx",
      "args": ["-y", "@wanji/bb-browser-mcp"]
    }
  }
}
```

If you already installed `@wanji/bb-browser-mcp` globally:

```json
{
  "mcpServers": {
    "bb-browser": {
      "command": "bb-browser-mcp"
    }
  }
}
```
