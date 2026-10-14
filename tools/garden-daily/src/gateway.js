import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// 连花园 MCP 的客户端。只负责把一次调用原样转过去，不重试。
export class GardenGateway {
  constructor(endpoint, token) {
    this.endpoint = endpoint;
    this.token = token;
    this.client = undefined;
  }

  async callTool(name, args) {
    const client = await this.getClient();
    try {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []).flatMap((entry) => entry.type === "text" ? [{ type: "text", text: entry.text }] : []);
      return {
        content,
        ...(result.isError === true ? { isError: true } : {}),
        ...(isObject(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
      };
    } catch (error) {
      // 连接断了就丢掉旧客户端，下一步重新连；这一步本身算「不确定」。
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async close() {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close();
  }

  async getClient() {
    if (this.client) return this.client;
    const client = new Client({ name: "garden-daily", version: "0.1.0" }, { versionNegotiation: { mode: "legacy" } });
    const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined;
    const transport = new StreamableHTTPClientTransport(this.endpoint, headers ? { requestInit: { headers } } : undefined);
    await client.connect(transport);
    this.client = client;
    return client;
  }
}

// 演练用：查询照常发，会动手的命令只记下来不发。
export class DryRunGateway {
  constructor(inner) {
    this.inner = inner;
    this.skipped = [];
  }

  async callTool(name, args) {
    const command = typeof args.command === "string" ? args.command : "";
    if (/^(status|shop)\b/u.test(command)) return this.inner.callTool(name, args);
    this.skipped.push(command ? `${name} ${command}` : name);
    return { content: [{ type: "text", text: JSON.stringify({ dry_run: true }) }] };
  }

  async close() {
    await this.inner.close?.();
  }
}

export function safeEndpoint(value) {
  if (!value) throw new Error("需要环境变量 MOONLIGHT_GARDEN_MCP_URL。");
  const endpoint = new URL(value);
  const local = endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !local) throw new Error("MOONLIGHT_GARDEN_MCP_URL 必须是 HTTPS（本机调试可用 localhost）。");
  return endpoint;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
