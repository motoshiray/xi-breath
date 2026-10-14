// 月光花园每日一键。顺序：收菜 → 补种＋浇水 → 鸡窝 → 伙伴 → 零活 → 钓鱼 → 蜂群。
// 每一步各自兜错，一步失败不拦后面；网络断了的步骤标「?」，从不自动重试。
// 硬规矩：不做菜、不卖、不偷、不碰蜂的 keep/release/free/name，不调用会返回菜谱的接口。

const COMMON_RARITIES = new Set(["common", "normal", "普通", "常见"]);

export async function runGardenDaily({ gateway, config, now = () => new Date() }) {
  const day = now().toISOString().slice(0, 10);
  const out = new Report();
  const ctx = { gateway, config, out, inventory: {}, inventoryKnown: false, balance: undefined, cropLabels: {} };

  // 先看一眼农场：连都连不上就什么都不做，省得每步都报一遍「不确定」。
  const probe = await call(ctx, "farm", "status");
  if (probe.kind === "unknown") return { day, text: `花园日 ${day}（UTC）\n✗ 连不上花园（${probe.reason}），今天什么都没做` };

  for (const step of [harvestStep, plantAndWaterStep, coopStep, petStep, workStep, fishStep, beeStep]) {
    try {
      await step(ctx);
    } catch (error) {
      out.fail(step.label, `内部错误（${shortReason(error)}）`);
    }
  }
  await balanceStep(ctx);

  return { day, text: [`花园日 ${day}（UTC）`, ...out.lines].join("\n") };
}

// ── 1. 收菜 ────────────────────────────────────────────────
async function harvestStep(ctx) {
  const res = await call(ctx, "farm", "harvest");
  if (res.kind === "unknown") return ctx.out.unsure("收菜", res.reason);
  if (res.kind === "err") {
    if (isNothing(res.code)) return;
    return ctx.out.fail("收菜", res.code);
  }
  const harvested = Array.isArray(res.data.harvested) ? res.data.harvested : [];
  if (harvested.length === 0) return;
  const counts = new Map();
  const stolen = [];
  for (const row of harvested) {
    const label = row.crop_name || ctx.config.cropNames[row.crop] || row.crop || "?";
    if (row.crop) ctx.cropLabels[`crop_${row.crop}`] = label;
    counts.set(label, (counts.get(label) ?? 0) + (typeof row.stored === "number" ? row.stored : 1));
    if (row.was_stolen || row.stolen_by) stolen.push(`${row.plot}号地被 ${row.stolen_by || "人"} 薅过`);
  }
  const list = [...counts].map(([label, n]) => `${label}${n}`).join("、");
  ctx.out.line(`收：${list}${stolen.length ? `（${stolen.join("；")}）` : ""}`);
}
harvestStep.label = "收菜";

// ── 2. 补种＋浇水 ──────────────────────────────────────────
async function plantAndWaterStep(ctx) {
  const { config, out } = ctx;
  const status = await call(ctx, "farm", "status");
  if (status.kind !== "ok" || !Array.isArray(status.data.plots)) {
    const why = status.kind === "unknown" ? `读不到地块（${status.reason}）` : `读不到地块（${status.code ?? "格式不对"}）`;
    out.fail("种", `${why}，没买种、没种`);
    const water = await waterOnly(ctx, undefined);
    if (water) out.line(water);
    return;
  }
  readInventory(ctx, status.data);

  const house = status.data.house?.plot;
  const empty = [];
  const unplanned = [];
  for (const plot of status.data.plots) {
    if (plot?.state !== "empty" || plot.plot === house) continue;
    const crop = config.plots[String(plot.plot)];
    if (crop === undefined) unplanned.push(plot.plot);
    else if (crop !== null && crop !== "house") empty.push({ plot: plot.plot, crop });
  }

  // 只按这次要种的量买种子：缺几颗买几颗。
  const available = {};
  const parts = [];
  const problems = [];
  for (const crop of [...new Set(empty.map((entry) => entry.crop))]) {
    const need = empty.filter((entry) => entry.crop === crop).length;
    const have = ctx.inventory[`seed_${crop}`] ?? 0;
    available[crop] = have;
    if (have >= need) continue;
    const buy = await call(ctx, "farm", `buy seed_${crop} ${need - have}`);
    if (buy.kind === "ok") available[crop] = need;
    else if (buy.kind === "unknown") problems.push(`? 买种 ${crop}×${need - have}：不确定（${buy.reason}），没重试`);
    else problems.push(`✗ 买种 ${crop}：${buy.code}`);
  }

  for (const { plot, crop } of empty) {
    if ((available[crop] ?? 0) <= 0) {
      problems.push(`✗ 种：${plot}号地没种子`);
      continue;
    }
    const res = await call(ctx, "farm", `plant ${plot} ${crop}`);
    if (res.kind === "ok") {
      available[crop] -= 1;
      parts.push(`${plot}${config.cropNames[crop] ?? crop}`);
    } else if (res.kind === "unknown") {
      problems.push(`? 种：${plot}号地不确定（${res.reason}）`);
    } else {
      problems.push(`✗ 种：${plot}号地 ${res.code}`);
    }
  }

  let water = await waterOnly(ctx, status.data.water_cooldown_seconds);
  // 冷却中不算错：只有这次新种了地才提一句「没浇上」。
  if (!parts.length && water.startsWith("浇水冷却")) water = "";
  if (parts.length || water) {
    out.line(`种：${parts.length ? parts.join(" ") : "—"}${water ? `；${water}` : ""}${unplanned.length ? `（${unplanned.join("、")}号空着，不在计划里）` : ""}`);
  } else if (unplanned.length) {
    out.line(`种：${unplanned.join("、")}号空着，不在计划里`);
  }
  for (const problem of problems) out.line(problem);
}
plantAndWaterStep.label = "种";

// 返回要并进「种」那一行的浇水说明；没事可报时返回空串。
async function waterOnly(ctx, cooldownSeconds) {
  if (typeof cooldownSeconds === "number" && cooldownSeconds > 0) return `浇水冷却中（还要${Math.ceil(cooldownSeconds / 60)}分）`;
  const res = await call(ctx, "farm", "water");
  if (res.kind === "ok") return "浇水✓";
  if (res.kind === "unknown") return `浇水?（${res.reason}）`;
  if (res.code === "nothing_to_water" || isNothing(res.code)) return "";
  if (/cooldown/u.test(res.code)) return "浇水冷却中";
  return `浇水✗ ${res.code}`;
}

// ── 3. 鸡窝 ───────────────────────────────────────────────
async function coopStep(ctx) {
  const { out } = ctx;
  const bits = [];

  const collect = await call(ctx, "coop", "collect");
  if (collect.kind === "ok") {
    const eggs = countEggs(collect.data);
    if (eggs > 0) bits.push(`蛋${eggs}`);
  } else if (collect.kind === "unknown") {
    bits.push(`收蛋?（${collect.reason}）`);
  } else if (!isNothing(collect.code) && !/no_egg/u.test(collect.code)) {
    bits.push(`收蛋✗ ${collect.code}`);
  }

  // 先喂白菜；没有就喂最便宜的 crop_*（按种子价估，查不到价就不乱喂）。
  // 伙伴的口粮只在喂完鸡还剩时才拿来喂鸡。
  const coop = await call(ctx, "coop", "status");
  const chickens = coop.kind === "ok" && Array.isArray(coop.data.chickens) ? coop.data.chickens : undefined;
  let hungry = chickens ? chickens.filter((chicken) => chicken?.state === "hungry").length : undefined;
  if (hungry === 0) return bits.length && out.line(`鸡：${bits.join("，")}`);

  const candidates = await feedOrder(ctx, hungry);
  const fed = [];
  for (const item of candidates) {
    if (hungry !== undefined && hungry <= 0) break;
    const res = await call(ctx, "coop", `feed ${item}`);
    if (res.kind === "ok") {
      const used = Math.min(ctx.inventory[item] ?? 0, hungry ?? Infinity);
      ctx.inventory[item] = (ctx.inventory[item] ?? 0) - used;
      if (hungry !== undefined) hungry -= used;
      fed.push(labelOf(ctx, item));
      continue;
    }
    if (res.kind === "err" && res.code === "all_fed") break;
    if (res.kind === "unknown") {
      bits.push(`喂鸡?（${res.reason}）`);
      break;
    }
    if (!/no_|not_enough|missing/u.test(res.code)) {
      bits.push(`喂鸡✗ ${res.code}`);
      break;
    }
  }
  if (fed.length) bits.push(`喂了${fed.join("、")}`);
  else if (candidates.length === 0 && hungry !== 0) bits.push(hungry === undefined ? "没白菜，没喂" : `${hungry}只饿着，没合适的菜喂`);
  else if (candidates.length && !fed.length && hungry > 0) bits.push(`${hungry}只饿着，没喂上`);
  if (bits.length) out.line(`鸡：${bits.join("，")}`);
}
coopStep.label = "鸡";

async function feedOrder(ctx, hungry) {
  const { config, inventory } = ctx;
  // 读不到背包时只试白菜，不拿别的菜乱喂。
  if (!ctx.inventoryKnown) return config.chickenFood ? [config.chickenFood] : [];
  const order = [];
  if (config.chickenFood && (inventory[config.chickenFood] ?? 0) > 0) order.push(config.chickenFood);
  const others = Object.keys(inventory).filter((item) => item.startsWith("crop_") && item !== config.chickenFood && inventory[item] > 0)
    .filter((item) => item !== config.petFood || inventory[item] - (hungry ?? Infinity) >= 1);
  if (others.length === 0) return order;
  const prices = await seedPrices(ctx);
  if (!prices) return order;
  const priced = others.filter((item) => prices.has(item.slice(5))).sort((a, b) => prices.get(a.slice(5)) - prices.get(b.slice(5)) || a.localeCompare(b));
  return [...order, ...priced];
}

async function seedPrices(ctx) {
  const res = await call(ctx, "farm", "shop");
  if (res.kind !== "ok") return undefined;
  const prices = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const id = typeof value.item === "string" ? value.item : typeof value.id === "string" ? value.id : undefined;
    if (id?.startsWith("seed_") && typeof value.price === "number") prices.set(id.slice(5), value.price);
    for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
  };
  visit(res.data);
  return prices.size ? prices : undefined;
}

function countEggs(data) {
  for (const key of ["collected", "eggs", "count"]) {
    if (typeof data[key] === "number") return data[key];
    if (Array.isArray(data[key])) return data[key].length;
  }
  return 0;
}

// ── 4. 伙伴 ───────────────────────────────────────────────
async function petStep(ctx) {
  const food = ctx.config.petFood;
  if (!food || (ctx.inventory[food] ?? 0) <= 0) return;
  const res = await call(ctx, "pet", `tend ${food}`);
  if (res.kind === "unknown") return ctx.out.unsure("伙伴", res.reason);
  if (res.kind === "err") {
    if (res.code === "tended_today" || /no_pet|^no_/u.test(res.code)) return;
    return ctx.out.fail("伙伴", res.code);
  }
  ctx.inventory[food] -= 1;
  const name = typeof res.data.name === "string" ? res.data.name : typeof res.data.pet?.name === "string" ? res.data.pet.name : "伙伴";
  ctx.out.line(`${name}：喂了${labelOf(ctx, food)}`);
}
petStep.label = "伙伴";

// ── 5. 零活 ───────────────────────────────────────────────
async function workStep(ctx) {
  let earned = 0;
  let done = 0;
  for (let i = 0; i < ctx.config.work.times; i += 1) {
    const res = await call(ctx, "garden_work");
    if (res.kind === "unknown") {
      if (done) ctx.out.line(workText(done, earned));
      return ctx.out.unsure("零活", `第${i + 1}次${res.reason}`);
    }
    if (res.kind === "err") {
      if (isWorkLimit(res.data, res.code)) break;
      if (done) ctx.out.line(workText(done, earned));
      return ctx.out.fail("零活", res.code);
    }
    done += 1;
    if (typeof res.data.moon === "number") earned += res.data.moon;
    if (isWorkLimit(res.data)) break;
  }
  if (done) ctx.out.line(workText(done, earned));
}

function workText(done, earned) {
  return earned ? `零活：+${earned}` : `零活：${done}次`;
}
workStep.label = "零活";

function isWorkLimit(data, code) {
  return code === "work_limit" || data?.code === "work_limit" || data?.work_remaining === 0 || data?.works_remaining === 0;
}

// ── 6. 钓鱼 ───────────────────────────────────────────────
async function fishStep(ctx) {
  const { bait, casts } = ctx.config.fishing;
  if (casts === 0) return;
  const status = await call(ctx, "fish", "status");
  if (status.kind === "unknown") return ctx.out.unsure("钓鱼", `读不到状态（${status.reason}），没买饵、没钓`);
  if (status.kind === "err" || typeof status.data.casts_remaining !== "number") return ctx.out.fail("钓鱼", `读不到状态（${status.code ?? "格式不对"}），没买饵、没钓`);
  const remaining = status.data.casts_remaining;
  if (remaining <= 0) return;

  const want = Math.min(casts, remaining);
  const baits = Array.isArray(status.data.bait) ? status.data.bait : [];
  let have = baits.find((row) => row?.key === bait)?.quantity ?? 0;
  if (have < want) {
    const buy = await call(ctx, "fish", `buy ${bait} ${want - have}`);
    if (buy.kind === "unknown") return ctx.out.unsure("钓鱼", `买饵${want - have}条结果不确定（${buy.reason}），没重试、没钓`);
    if (buy.kind === "ok") have = want;
    else if (have === 0) return ctx.out.fail("钓鱼", `买饵失败 ${buy.code}`);
    else ctx.out.fail("买饵", `${buy.code}，用手头${have}条钓`);
  }

  const n = Math.min(want, have);
  const res = await call(ctx, "fish", bait === "bread" ? `cast ${n}` : `cast ${n} ${bait}`);
  if (res.kind === "unknown") return ctx.out.unsure("钓鱼", res.reason);
  if (res.kind === "err") return ctx.out.fail("钓鱼", res.code);

  const list = Array.isArray(res.data.casts) ? res.data.casts : [];
  const fresh = (Array.isArray(res.data.new_species) ? res.data.new_species : []).map(fishName).filter(Boolean);
  const rare = [...new Set(list.filter((row) => row && !row.empty && row.rarity && !COMMON_RARITIES.has(row.rarity)).map(fishName).filter(Boolean))];
  ctx.out.line(`钓鱼：${list.length || n}杆${fresh.length ? `｜新：${fresh.join("、")}` : ""}${rare.length ? `｜稀有：${rare.join("、")}` : ""}`);
}
fishStep.label = "钓鱼";

function fishName(value) {
  if (typeof value === "string") return value;
  return value?.fish_name ?? value?.name ?? "";
}

// ── 7. 蜂群 ───────────────────────────────────────────────
// 门口有幼蜂就停：不 settle、不 send、不 keep/release，只列出来等 Rui 挑。
async function beeStep(ctx) {
  const status = await call(ctx, "bee", "status");
  if (status.kind === "unknown") return ctx.out.unsure("蜂", status.reason);
  if (status.kind === "err") return ctx.out.fail("蜂", status.code);
  const data = status.data;

  const waiting = Array.isArray(data.waiting) ? data.waiting : [];
  if (waiting.length) return ctx.out.line(youngLines(`蜂：门口幼蜂${waiting.length}只等挑${data.out ? "（蜂群这次没收，先挑完再说）" : ""}：`, waiting));

  let honeyText = "";
  if (data.out) {
    if (!beeIsBack(data)) return;
    const settle = await call(ctx, "bee", "settle");
    if (settle.kind === "unknown") return ctx.out.unsure("蜂", `settle ${settle.reason}，没 send`);
    if (settle.kind === "err") return ctx.out.fail("蜂", `settle ${settle.code}，没 send`);
    honeyText = honeySummary(settle.data.honey);
    const young = Array.isArray(settle.data.young) ? settle.data.young : [];
    if (young.length) return ctx.out.line(youngLines(`蜂：${honeyText ? `${honeyText}｜` : ""}门口幼蜂${young.length}只等挑：`, young));
  }

  const hive = Array.isArray(data.hive) ? data.hive : [];
  const tripsLeft = typeof data.trips_left_today === "number" ? data.trips_left_today : 0;
  if (!hive.length || tripsLeft <= 0) return honeyText && ctx.out.line(`蜂：${honeyText}`);
  const send = await call(ctx, "bee", "send");
  const sendText = send.kind === "ok" ? `派出去了${send.data.back_in ? `，${send.data.back_in}后回` : ""}`
    : send.kind === "unknown" ? `send?（${send.reason}）` : `send✗ ${send.code}`;
  ctx.out.line(`蜂：${honeyText ? `${honeyText}｜` : ""}${sendText}`);
}
beeStep.label = "蜂";

function beeIsBack(data) {
  if (typeof data.hint === "string" && data.hint.includes("回来了")) return true;
  if (data.back_in === "一会儿") return true;
  return typeof data.back_at === "number" && data.back_at * 1000 <= Date.now();
}

function honeySummary(honey) {
  if (!Array.isArray(honey) || honey.length === 0) return "";
  let total = 0;
  const kinds = [];
  for (const row of honey) {
    const qty = typeof row?.quantity === "number" ? row.quantity : typeof row?.qty === "number" ? row.qty : 1;
    total += qty;
    const name = typeof row === "string" ? row : row?.name ?? row?.item;
    if (name) kinds.push(`${name}${qty}`);
  }
  return `收蜜${total}${kinds.length > 1 ? `（${kinds.join("、")}）` : ""}`;
}

function youngLines(head, young) {
  return [head, ...young.map((bee, index) => {
    const parents = bee.parents_text ? `（${bee.parents_text}）` : "";
    return `  ${index + 1} ${bee.label ?? bee.bee_id ?? "?"}${parents}${bee.new_to_codex ? "新" : ""}`;
  })].join("\n");
}

// ── 余额 ──────────────────────────────────────────────────
async function balanceStep(ctx) {
  const res = await call(ctx, "farm", "status");
  if (res.kind === "ok" && typeof res.data.moon_balance === "number") ctx.balance = res.data.moon_balance;
  if (typeof ctx.balance === "number") ctx.out.line(`余额：${ctx.balance} moon`);
}

// ── 公用 ──────────────────────────────────────────────────
class Report {
  constructor() { this.lines = []; }
  line(text) { if (text) this.lines.push(text); }
  fail(step, reason) { this.lines.push(`✗ ${step}：${reason}`); }
  unsure(step, reason) { this.lines.push(`? ${step}：不确定（${reason}），没重试`); }
}

async function call(ctx, tool, command) {
  let raw;
  try {
    raw = await ctx.gateway.callTool(tool, command === undefined ? {} : { command });
  } catch (error) {
    return { kind: "unknown", reason: shortReason(error) };
  }
  const data = parseData(raw);
  if (typeof data.moon_balance === "number") ctx.balance = data.moon_balance;
  const code = errorCode(raw, data);
  return code ? { kind: "err", code, data } : { kind: "ok", data };
}

function parseData(raw) {
  if (raw?.structuredContent && typeof raw.structuredContent === "object") return raw.structuredContent;
  const text = raw?.content?.find((entry) => entry.type === "text")?.text ?? "";
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { text };
  }
}

function errorCode(raw, data) {
  const explicit = typeof data.code === "string" ? data.code : typeof data.error === "string" ? data.error : undefined;
  if (raw?.isError) return explicit ?? (data.text ? data.text.slice(0, 40) : "error");
  if (data.ok === false || typeof data.error === "string") return explicit ?? "error";
  return undefined;
}

function readInventory(ctx, data) {
  const inventory = data.inventory;
  ctx.inventoryKnown = Boolean(inventory && typeof inventory === "object");
  if (inventory && typeof inventory === "object" && !Array.isArray(inventory)) {
    for (const [item, qty] of Object.entries(inventory)) if (typeof qty === "number") ctx.inventory[item] = qty;
  } else if (Array.isArray(inventory)) {
    for (const row of inventory) if (typeof row?.item === "string" && typeof row.quantity === "number") ctx.inventory[row.item] = row.quantity;
  }
}

function labelOf(ctx, item) {
  const crop = item.replace(/^crop_/u, "");
  return ctx.cropLabels[item] ?? ctx.config.cropNames[crop] ?? crop;
}

function isNothing(code) {
  return typeof code === "string" && /^nothing|^no_(mature|ripe|crop|egg)|empty/u.test(code);
}

function shortReason(error) {
  const code = error?.code ?? error?.cause?.code;
  if (typeof code === "string") return code;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out/iu.test(message) ? "超时" : message.slice(0, 40) || "连接出错";
}
