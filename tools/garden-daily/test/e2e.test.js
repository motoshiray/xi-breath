// 端到端：起一个本机假花园 MCP（HTTP），用真正的入口 `src/index.js --once` 连过去跑一天。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

// 值是数组时依次返回（最后一个一直重复），模拟动手前后状态的变化。
const RESPONSES = {
  "farm harvest": { harvested: [{ plot: 2, crop: "cabbage", crop_name: "白菜", stored: 1 }] },
  "farm status": [
    { plots: [{ plot: 1, state: "house" }, { plot: 2, state: "mature", crop: "cabbage" }], house: { plot: 1 }, inventory: { seed_cabbage: 1 }, moon_balance: 500, water_cooldown_seconds: 0 },
    { plots: [{ plot: 1, state: "house" }, { plot: 2, state: "empty" }], house: { plot: 1 }, inventory: { crop_cabbage: 1, seed_cabbage: 1 }, moon_balance: 500, water_cooldown_seconds: 0 },
  ],
  "farm plant 2 cabbage": { planted: 2 },
  "farm water": { watered: [2] },
  "coop collect": { collected: 1 },
  "coop status": [{ chickens: [{ index: 1, state: "ready" }] }, { chickens: [{ index: 1, state: "laying" }] }],
  "pet status": { pets: [], slots_free: 2 },
  "fish status": { casts_remaining: 0, bait: [] },
  "bee status": { hive: [], trips_left_today: 0, waiting: [] },
};

const FARM_STATUS = [...RESPONSES["farm status"]];
const COOP_STATUS = [...RESPONSES["coop status"]];

let worksToday = 0;

function fakeGarden(calls) {
  const server = new McpServer({ name: "fake-garden", version: "0.0.0" }, { capabilities: { tools: {} } });
  for (const tool of ["farm", "coop", "pet", "fish", "bee"]) {
    server.registerTool(tool, { inputSchema: z.object({ command: z.string() }) }, async ({ command }) => {
      calls.push(`${tool} ${command}`);
      const scripted = RESPONSES[`${tool} ${command}`];
      if (!scripted) return { content: [{ type: "text", text: `Error executing tool ${tool}: 没准备这条` }], isError: true };
      const data = Array.isArray(scripted) ? (scripted.length > 1 ? scripted.shift() : scripted[0]) : scripted;
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    });
  }
  server.registerTool("garden_work", { inputSchema: z.object({}) }, async () => {
    calls.push("garden_work");
    worksToday += 1;
    if (worksToday > 3) return { content: [{ type: "text", text: "Error executing tool garden_work: 今天已经打工" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify({ job: "扫落叶", moon: 15 }) }] };
  });
  return server;
}

test("真入口连本机假花园跑一天", async () => {
  const calls = [];
  const handler = createMcpHandler(() => fakeGarden(calls));
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "garden-daily-"));
    const config = path.join(dir, "garden-daily.config.json");
    await writeFile(config, JSON.stringify({ plots: { 1: "house", 2: "cabbage" }, petFood: null }));
    const env = { ...process.env, MOONLIGHT_GARDEN_MCP_URL: `http://127.0.0.1:${port}/mcp` };

    const dry = await run(process.execPath, [ENTRY, "--config", config, "--once", "--dry-run"], { env });
    assert.match(dry.stdout, /【演练，没动手】/u);
    assert.match(dry.stdout, /farm harvest/u);
    assert.ok(calls.every((call) => / (status|shop)$/u.test(call)), `演练不该动手：${calls.join(", ")}`);

    calls.length = 0;
    RESPONSES["farm status"] = [...FARM_STATUS];
    RESPONSES["coop status"] = [...COOP_STATUS];
    const { stdout } = await run(process.execPath, [ENTRY, "--config", config, "--once"], { env });
    assert.equal(stdout.trim(), [
      /^花园日 \d{4}-\d{2}-\d{2}（UTC）$/u.exec(stdout.split("\n")[0])?.[0],
      "收：白菜1",
      "种：2白菜；浇水✓",
      "鸡：蛋1",
      "零活：+45",
      "余额：500 moon",
    ].join("\n"));
    assert.equal(calls.filter((call) => call === "garden_work").length, 3);

    // 同一天再跑：没熟的地、没蛋，零活被花园以「今天已经打工」拒掉，小结里不该有 ✗。
    calls.length = 0;
    const again = await run(process.execPath, [ENTRY, "--config", config, "--once"], { env });
    assert.doesNotMatch(again.stdout, /✗/u);
    assert.match(again.stdout, /余额：500 moon/u);
    assert.deepEqual(calls.filter((call) => call === "garden_work"), ["garden_work"]);
  } finally {
    http.close();
  }
});
