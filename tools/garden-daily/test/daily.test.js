import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.js";
import { runGardenDaily } from "../src/daily.js";
import { DryRunGateway } from "../src/gateway.js";

const NOW = () => new Date("2026-10-15T01:00:00Z");

function raw(data, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) };
}

// 假花园：按 "工具 命令" 取回包；值可以是数组（依次返回）或 Error（模拟断线）。
class FakeGarden {
  constructor(responses) {
    this.responses = responses;
    this.calls = [];
  }

  async callTool(name, args) {
    const key = `${name} ${args.command ?? ""}`.trim();
    this.calls.push(key);
    let value = this.responses[key];
    if (Array.isArray(value)) value = value.length > 1 ? value.shift() : value[0];
    if (value instanceof Error) throw value;
    if (!value) throw new Error(`没有准备回包：${key}`);
    return value;
  }
}

const FORBIDDEN = /^(kitchen|inventory|house|hunt|park)\b|\b(steal|scout|sell|keep|release|free|name|expand|buy plot|buy fence|leave)\b|^coop buy$|^bee buy$/u;

function busyDay(overrides = {}) {
  return new FakeGarden({
    "farm harvest": raw({ harvested: [
      { plot: 2, crop: "cabbage", crop_name: "白菜", stored: 1, moon: 0 },
      { plot: 3, crop: "autumn_chestnut", crop_name: "秋月栗", stored: 1, moon: 0, was_stolen: true, stolen_by: "Aster" },
      { plot: 4, crop: "autumn_chestnut", crop_name: "秋月栗", stored: 1, moon: 0 },
    ] }),
    "farm status": raw({
      plots: [
        { plot: 1, state: "house" },
        { plot: 2, state: "empty" },
        { plot: 3, state: "empty" },
        { plot: 4, state: "empty" },
        { plot: 5, state: "growing", crop: "moonlight_rose" },
      ],
      house: { plot: 1 },
      inventory: { crop_cabbage: 3, crop_autumn_chestnut: 2, seed_autumn_chestnut: 1 },
      moon_balance: 2702,
      water_cooldown_seconds: 0,
    }),
    "farm buy seed_cabbage 1": raw({ bought: "seed_cabbage", quantity: 1 }),
    "farm buy seed_autumn_chestnut 1": raw({ bought: "seed_autumn_chestnut", quantity: 1 }),
    "farm plant 2 cabbage": raw({ planted: 2 }),
    "farm plant 3 autumn_chestnut": raw({ planted: 3 }),
    "farm plant 4 autumn_chestnut": raw({ planted: 4 }),
    "farm water": raw({ watered: [2, 3, 4, 5] }),
    "coop collect": raw({ collected: 2 }),
    "coop status": raw({ chickens: [{ index: 1, state: "hungry" }, { index: 2, state: "hungry" }] }),
    "coop feed crop_cabbage": raw({ fed: 2 }),
    "pet tend crop_autumn_chestnut": raw({ name: "貘" }),
    "garden_work": [raw({ job: "a", moon: 15, moon_balance: 2660 }), raw({ job: "b", moon: 15 }), raw({ job: "c", moon: 15 })],
    "fish status": raw({ casts_remaining: 10, bait: [] }),
    "fish buy bread 10": raw({ bought: "bait_bread", quantity: 10 }),
    "fish cast 10": raw({
      casts: [{ fish_name: "沉星鳢", rarity: "uncommon" }, { fish_name: "丰收神鱼", rarity: "legendary" }, ...Array(8).fill({ fish_name: "小鲫", rarity: "common" })],
      new_species: ["沉星鳢"],
    }),
    "bee status": raw({ hive: [{ index: 1 }], count: "1/4", trips_left_today: 1, waiting: [], out: true, back_in: "一会儿", hint: "蜂群回来了，settle 收蜜" }),
    "bee settle": raw({ visited: "x", honey: [{ name: "百花蜜", quantity: 6 }, { name: "幻光蘑菇蜜", quantity: 1 }], young: [
      { bee_id: "y1", label: "霜白·菱格·潜根", parents_text: "睿蜜×沈克家小霜", new_to_codex: true },
    ] }),
    ...overrides,
  });
}

test("忙碌的一天：小结和需求里的样子一致，且很短", async () => {
  const garden = busyDay();
  const { text } = await runGardenDaily({ gateway: garden, config: DEFAULT_CONFIG, now: NOW });
  assert.equal(text, [
    "花园日 2026-10-15（UTC）",
    "收：白菜1、秋月栗2（3号地被 Aster 薅过）",
    "种：2白菜 3栗 4栗；浇水✓",
    "鸡：蛋2，喂了白菜",
    "貘：喂了秋月栗",
    "零活：+45",
    "钓鱼：10杆｜新：沉星鳢｜稀有：沉星鳢、丰收神鱼",
    "蜂：收蜜7（百花蜜6、幻光蘑菇蜜1）｜门口幼蜂1只等挑：",
    "  1 霜白·菱格·潜根（睿蜜×沈克家小霜）新",
    "余额：2702 moon",
  ].join("\n"));
  assert.ok(text.length < 600);
  assert.ok(!garden.calls.includes("bee send"), "门口有幼蜂时不能 send");
  for (const call of garden.calls) assert.doesNotMatch(call, FORBIDDEN);
});

test("门口已有幼蜂：不 settle、不 send，只列出来", async () => {
  const garden = busyDay({
    "bee status": raw({ hive: [{ index: 1 }], trips_left_today: 1, out: true, back_in: "一会儿", hint: "回来了", waiting: [
      { bee_id: "a", label: "蜜金·斑点·醉果", parents_text: "甲×乙", new_to_codex: false },
      { bee_id: "b", label: "霜白·斑点·逐月", parents_text: "丙×丁", new_to_codex: true },
    ] }),
  });
  const { text } = await runGardenDaily({ gateway: garden, config: DEFAULT_CONFIG, now: NOW });
  assert.match(text, /门口幼蜂2只等挑/u);
  assert.match(text, / {2}2 霜白·斑点·逐月（丙×丁）新/u);
  assert.ok(!garden.calls.includes("bee settle"));
  assert.ok(!garden.calls.includes("bee send"));
});

test("蜂回来、门口没幼蜂 → settle 后 send；蜂在外面 → 什么都不做", async () => {
  const back = busyDay({
    "bee settle": raw({ honey: [{ name: "百花蜜", quantity: 5 }], young: [] }),
    "bee send": raw({ back_at: 1, back_in: "4小时" }),
  });
  const { text } = await runGardenDaily({ gateway: back, config: DEFAULT_CONFIG, now: NOW });
  assert.match(text, /蜂：收蜜5｜派出去了，4小时后回/u);

  const away = busyDay({ "bee status": raw({ hive: [{ index: 1 }], trips_left_today: 0, waiting: [], out: true, back_in: "2小时", hint: "还在外面" }) });
  const result = await runGardenDaily({ gateway: away, config: DEFAULT_CONFIG, now: NOW });
  assert.doesNotMatch(result.text, /蜂/u);
  assert.deepEqual(away.calls.filter((call) => call.startsWith("bee")), ["bee status"]);
});

test("同一天重跑：零活满、伙伴喂过、钓鱼满、没东西收，都静默跳过", async () => {
  const garden = new FakeGarden({
    "farm harvest": raw({ code: "nothing_to_harvest" }, true),
    "farm status": raw({ plots: [{ plot: 1, state: "house" }, { plot: 2, state: "growing", crop: "cabbage" }], house: { plot: 1 }, inventory: { crop_autumn_chestnut: 1 }, moon_balance: 2747, water_cooldown_seconds: 3000 }),
    "coop collect": raw({ code: "no_eggs" }, true),
    "coop status": raw({ chickens: [{ index: 1, state: "laying" }] }),
    "pet tend crop_autumn_chestnut": raw({ code: "tended_today" }, true),
    "garden_work": raw({ code: "work_limit" }, true),
    "fish status": raw({ casts_remaining: 0, bait: [] }),
    "bee status": raw({ hive: [{ index: 1 }], trips_left_today: 0, waiting: [], out: false }),
  });
  const { text } = await runGardenDaily({ gateway: garden, config: DEFAULT_CONFIG, now: NOW });
  assert.equal(text, "花园日 2026-10-15（UTC）\n余额：2747 moon");
  assert.equal(garden.calls.filter((call) => call === "garden_work").length, 1);
  assert.ok(!garden.calls.some((call) => call.startsWith("fish buy") || call.startsWith("fish cast")));
  assert.ok(!garden.calls.includes("farm water"), "冷却中不浇");
});

test("买面包虫时断线：标「?」、不钓、不重试，后面的蜂照常跑", async () => {
  const garden = busyDay({ "fish buy bread 10": Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  const { text } = await runGardenDaily({ gateway: garden, config: DEFAULT_CONFIG, now: NOW });
  assert.match(text, /\? 钓鱼：不确定（买饵10条结果不确定（ECONNRESET），没重试、没钓）/u);
  assert.equal(garden.calls.filter((call) => call === "fish buy bread 10").length, 1);
  assert.ok(!garden.calls.some((call) => call.startsWith("fish cast")));
  assert.match(text, /门口幼蜂1只等挑/u);
});

test("读不到地块时不买种子，零活出错也不拦后面", async () => {
  const garden = busyDay({
    "farm status": [raw({ moon_balance: 100 }), Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), raw({ moon_balance: 100 })],
    "garden_work": raw({ code: "server_busy" }, true),
  });
  const { text } = await runGardenDaily({ gateway: garden, config: DEFAULT_CONFIG, now: NOW });
  assert.match(text, /✗ 种：读不到地块（ETIMEDOUT），没买种、没种/u);
  assert.match(text, /✗ 零活：server_busy/u);
  assert.match(text, /钓鱼：10杆/u);
  assert.ok(!garden.calls.some((call) => call.startsWith("farm buy") || call.startsWith("farm plant")));
});

test("连不上花园：一句话说明，什么都不动", async () => {
  const garden = new FakeGarden({ "farm status": Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }) });
  const { text } = await runGardenDaily({ gateway: garden, config: DEFAULT_CONFIG, now: NOW });
  assert.equal(text, "花园日 2026-10-15（UTC）\n✗ 连不上花园（ECONNREFUSED），今天什么都没做");
  assert.deepEqual(garden.calls, ["farm status"]);
});

test("没白菜就喂最便宜的 crop_*，不动伙伴的口粮", async () => {
  const garden = busyDay({
    "farm harvest": raw({ harvested: [] }),
    "farm status": raw({ plots: [], inventory: { crop_moonlight_rose: 4, crop_carrot: 1, crop_autumn_chestnut: 1 }, moon_balance: 10, water_cooldown_seconds: 0 }),
    "farm water": raw({ code: "nothing_to_water" }, true),
    "farm shop": raw({ seeds: [{ item: "seed_moonlight_rose", price: 40 }, { item: "seed_carrot", price: 3 }, { item: "seed_autumn_chestnut", price: 1 }] }),
    "coop status": raw({ chickens: [{ index: 1, state: "hungry" }, { index: 2, state: "hungry" }] }),
    "coop feed crop_carrot": raw({ fed: 1 }),
    "coop feed crop_moonlight_rose": raw({ fed: 1 }),
  });
  const { text } = await runGardenDaily({ gateway: garden, config: DEFAULT_CONFIG, now: NOW });
  assert.match(text, /鸡：蛋2，喂了carrot、玫瑰/u);
  assert.ok(!garden.calls.includes("coop feed crop_autumn_chestnut"));
  assert.match(text, /貘：喂了/u);
});

test("演练：只发 status/shop，列出本来会执行的命令", async () => {
  const garden = busyDay();
  const dry = new DryRunGateway(garden);
  await runGardenDaily({ gateway: dry, config: DEFAULT_CONFIG, now: NOW });
  assert.ok(garden.calls.every((call) => / (status|shop)$/u.test(call)), garden.calls.join(", "));
  assert.ok(dry.skipped.includes("farm harvest"));
  assert.ok(dry.skipped.includes("garden_work"));
});
