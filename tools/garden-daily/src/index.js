#!/usr/bin/env node
// garden_daily 的 MCP 服务（stdio）。
//   node src/index.js --config /绝对路径/garden-daily.config.json
// 单次在终端跑（不挂 MCP）：
//   node --env-file=.env src/index.js --config ... --once [--dry-run]

import { mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { loadConfig } from "./config.js";
import { runGardenDaily } from "./daily.js";
import { DryRunGateway, GardenGateway, safeEndpoint } from "./gateway.js";

const DESCRIPTION = "月光花园每日一键：收菜（记录被谁薅过）→ 按地块计划补种＋浇水 → 收蛋喂鸡 → 喂伙伴 → 零活3次 → 钓鱼10杆 → 蜂群（回来就 settle，门口有幼蜂就停下列出来等挑，否则 send）。只回一张短小结（纯文本）。"
  + " 不做菜、不卖东西、不买地/鸡/蜂箱、不偷菜摸蛋、不碰蜂的 keep/release/free/name、不读菜谱。每步各自兜错；网络断了的步骤标「?」不重试。同一 UTC 日重跑会跳过已做完的事。"
  + " dryRun=true 只查状态，列出本来要执行的命令，不动手。";

async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  const configPath = configIndex >= 0 && args[configIndex + 1] ? path.resolve(args[configIndex + 1]) : undefined;
  const endpoint = safeEndpoint(process.env.MOONLIGHT_GARDEN_MCP_URL);
  const gateway = new GardenGateway(endpoint, process.env.MOONLIGHT_GARDEN_MCP_TOKEN);
  await loadConfig(configPath); // 启动时先校验一次，配置写错立刻报。

  const run = async (dryRun) => {
    const config = await loadConfig(configPath); // 每次调用重读，改了地块计划不用重启。
    const lockFile = path.join(configPath ? path.dirname(configPath) : process.cwd(), ".garden-daily.lock");
    return withLock(lockFile, async () => {
      const target = dryRun ? new DryRunGateway(gateway) : gateway;
      const { text } = await runGardenDaily({ gateway: target, config, dryRun });
      if (!dryRun) return text;
      const planned = target.skipped.length ? target.skipped.map((command) => `  ${command}`).join("\n") : "  （没有要动手的事）";
      return `【演练，没动手】\n${text}\n本来会执行：\n${planned}`;
    });
  };

  if (args.includes("--once")) {
    try {
      process.stdout.write(`${await run(args.includes("--dry-run"))}\n`);
    } finally {
      await gateway.close().catch(() => undefined);
    }
    return;
  }

  const handle = serveStdio(() => {
    const server = new McpServer({ name: "garden-daily", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.registerTool("garden_daily", {
      title: "月光花园每日一键",
      description: DESCRIPTION,
      inputSchema: z.object({ dryRun: z.boolean().optional().describe("true：只查状态并列出本来要执行的命令，不动手。") }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ dryRun }) => {
      try {
        return { content: [{ type: "text", text: await run(dryRun === true) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `✗ garden_daily 没跑起来：${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    });
    return server;
  }, { onerror: () => process.stderr.write("garden-daily MCP transport error.\n") });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void Promise.allSettled([handle.close(), gateway.close()]).finally(() => process.exit(0));
    });
  }
}

// 防止两个一键同时跑。锁超过 15 分钟视为上次进程已死。
async function withLock(file, task) {
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  try {
    handle = await open(file, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const info = await stat(file);
    if (Date.now() - info.mtimeMs < 15 * 60_000) throw new Error("另一个 garden_daily 正在跑，等它跑完再来。");
    await unlink(file);
    handle = await open(file, "wx");
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await task();
  } finally {
    await handle.close();
    await unlink(file).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
