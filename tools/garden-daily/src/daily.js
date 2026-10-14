// 月光花园每日一键。顺序：收菜 → 补种＋浇水 → 鸡窝 → 伙伴 → 零活 → 钓鱼 → 蜂群。
// 每一步各自兜错，一步失败不拦后面；网络断了的步骤标「?」，从不自动重试。
// 硬规矩：不做菜、不卖、不偷、不碰蜂的 keep/release/free/name，不调用会返回菜谱的接口。
//
// 真花园出错时回 isError ＋ 中文纯文本（如 "Error executing tool garden_work: 今天已经打工"），
// 没有稳定的错误码。所以「要不要动手」一律先看 status 里的 JSON 字段决定，
// 不靠撞报错来判断；只有零活没有可读的状态，才去认报错文本。

const COMMON_RARITIES = new Set(["common", "normal", "普通", "常见"]);
const WORK_DONE = /work_limit|今天已经打(过)?工|今天.*打过工|打工.*(次数|机会).*(用完|满)|明天再来/u;

export async function runGardenDaily({ gateway, config, dryRun = false, now = () => new Date() }) {
  const day = now().toISOString().slice(0, 10);
  const out = new Report();
  const ctx = { gateway, config, dry: dryRun, out, inventory: {}, inventoryKnown: false, balance: undefined, cropLabels: {} };

  // 先看一眼农场：连都连不上就什么都不做，省得每步都报一遍「不确定」。
  const probe = await call(ctx, "farm", "status");
  if (probe.kind === "unknown") return { day, text: `花园日 ${day}（UTC）\n✗ 连不上花园（${probe.reason}），今天什么都没做` };
  ctx.farm = probe.kind === "ok" && Array.isArray(probe.data.plots) ? probe.data : undefined;
  if (ctx.farm) readInventory(ctx, ctx.farm);

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
// 只有 status 里真有熟了的地才 harvest。
async function harvestStep(ctx) {
  if (!ctx.farm) return; // 读不到地块：下一步会报 ✗，这里不盲收。
  const ripe = ctx.farm.plots.filter(isRipe);
  if (ripe.length === 0) return;
  const res = await call(ctx, "farm", "harvest");
  if (res.kind === "unknown") return ctx.out.unsure("收菜", res.reason);
  if (res.kind === "err") return ctx.out.fail("收菜", res.code);
  if (ctx.dry) {
    ctx.harvestedPlots = ripe.map((plot) => plot.plot);
    return ctx.out.line(`会收：${ripe.map((plot) => `${plot.plot}${cropLabel(ctx, plot.crop)}`).join(" ")}`);
  }
  const harvested = Array.isArray(res.data.harvested) ? res.data.harvested : [];
  if (harvested.length === 0) return;
  const counts = new Map();
  const stolen = [];
  for (const row of harvested) {
    const label = row.crop_name || cropLabel(ctx, row.crop) || "?"; // 收菜行用花园给的全名
    if (row.crop) ctx.cropLabels[`crop_${row.crop}`] = label;
    counts.set(label, (counts.get(label) ?? 0) + (typeof row.stored === "number" ? row.stored : 1));
    if (row.was_stolen || row.stolen_by) stolen.push(`${row.plot}号地被 ${row.stolen_by || "人"} 薅过`);
  }
  const list = [...counts].map(([label, n]) => `${label}${n}`).join("、");
  ctx.out.line(`收：${list}${stolen.length ? `（${stolen.join("；")}）` : ""}`);
}
harvestStep.label = "收菜";

function isRipe(plot) {
  return plot?.state === "mature" || plot?.state === "ready";
}

// ── 2. 补种＋浇水 ──────────────────────────────────────────
async function plantAndWaterStep(ctx) {
  const { config, out } = ctx;
  let farm;
  if (ctx.dry) {
    // 演练没真收：把会收的地当成已经空出来，算出完整的种地计划。
    farm = ctx.farm && { ...ctx.farm, plots: ctx.farm.plots.map((plot) => ctx.harvestedPlots?.includes(plot.plot) ? { plot: plot.plot, state: "empty" } : plot) };
  } else {
    const status = await call(ctx, "farm", "status");
    farm = status.kind === "ok" && Array.isArray(status.data.plots) ? status.data : undefined;
    if (!farm && ctx.farm) {
      const why = status.kind === "unknown" ? status.reason : status.code ?? "格式不对";
      return out.fail("种", `收菜后读不到地块（${why}），没买种、没种、没浇`);
    }
  }
  if (!farm) return out.fail("种", "读不到地块，没收、没买种、没种、没浇");
  readInventory(ctx, farm);

  const house = farm.house?.plot;
  const empty = [];
  const unplanned = [];
  for (const plot of farm.plots) {
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
      parts.push(`${plot}${cropLabel(ctx, crop)}`);
    } else if (res.kind === "unknown") {
      problems.push(`? 种：${plot}号地不确定（${res.reason}）`);
    } else {
      problems.push(`✗ 种：${plot}号地 ${res.code}`);
    }
  }

  // 浇水：冷却中、或者地里没有在长的东西，就不浇（不去撞报错）。
  let water = "";
  const growing = parts.length > 0 || farm.plots.some((plot) => plot?.state === "growing");
  const cooldown = farm.water_cooldown_seconds;
  if (typeof cooldown === "number" && cooldown > 0) {
    if (parts.length) water = `浇水冷却中（还要${Math.ceil(cooldown / 60)}分）`;
  } else if (growing) {
    const res = await call(ctx, "farm", "water");
    water = res.kind === "ok" ? (ctx.dry ? "会浇水" : "浇水✓") : res.kind === "unknown" ? `浇水?（${res.reason}）` : `浇水✗ ${res.code}`;
  }

  const head = ctx.dry ? "会种" : "种";
  const note = unplanned.length ? `（${unplanned.join("、")}号空着，不在计划里）` : "";
  if (parts.length || water) out.line(`${head}：${parts.length ? parts.join(" ") : "—"}${water ? `；${water}` : ""}${note}`);
  else if (note) out.line(`种：${unplanned.join("、")}号空着，不在计划里`);
  for (const problem of problems) out.line(problem);
}
plantAndWaterStep.label = "种";

// ── 3. 鸡窝 ───────────────────────────────────────────────
// 先读 coop status：有蛋才 collect，有饿的才 feed；每喂一样就重读一次还剩几只饿着。
async function coopStep(ctx) {
  const { out } = ctx;
  const first = await readCoop(ctx);
  if (first.error) return out.fail("鸡", `读不到鸡窝（${first.error}），没收蛋、没喂`);
  if (first.chickens.length === 0) return;

  const bits = [];
  let hungry = first.hungry;
  if (first.ready > 0) {
    const collect = await call(ctx, "coop", "collect");
    if (collect.kind === "unknown") bits.push(`收蛋?（${collect.reason}）`);
    else if (collect.kind === "err") bits.push(`收蛋✗ ${collect.code}`);
    else if (ctx.dry) bits.push(`会收蛋${first.ready}`);
    else bits.push(`蛋${countEggs(collect.data) ?? first.ready}`);
    if (ctx.dry) {
      hungry += first.ready; // 演练：假设收完蛋的鸡都要喂。
    } else {
      const after = await readCoop(ctx);
      if (after.error) {
        bits.push(`收蛋后读不到鸡窝（${after.error}），没喂`);
        return out.line(`鸡：${bits.join("，")}`);
      }
      hungry = after.hungry;
    }
  }

  if (hungry > 0) {
    const candidates = await feedOrder(ctx, hungry);
    const fed = [];
    for (const item of candidates) {
      const res = await call(ctx, "coop", `feed ${item}`);
      if (res.kind === "unknown") {
        bits.push(`喂鸡?（${res.reason}）`);
        break;
      }
      if (res.kind === "err") {
        bits.push(`喂鸡✗ ${res.code}`);
        break;
      }
      fed.push(labelOf(ctx, item));
      if (ctx.dry) break;
      const after = await readCoop(ctx);
      if (after.error) break;
      hungry = after.hungry;
      if (hungry <= 0) break;
    }
    if (fed.length) bits.push(`${ctx.dry ? "会喂" : "喂了"}${fed.join("、")}`);
    if (!ctx.dry && hungry > 0) bits.push(`还有${hungry}只饿着${candidates.length ? "" : "（没合适的菜，没喂）"}`);
  }
  if (bits.length) out.line(`鸡：${bits.join("，")}`);
}
coopStep.label = "鸡";

async function readCoop(ctx) {
  const res = await call(ctx, "coop", "status");
  if (res.kind === "unknown") return { error: res.reason };
  if (res.kind === "err") return { error: res.code };
  if (!Array.isArray(res.data.chickens)) return { error: "格式不对" };
  const chickens = res.data.chickens;
  return {
    chickens,
    hungry: chickens.filter((chicken) => chicken?.state === "hungry").length,
    ready: chickens.filter((chicken) => chicken?.state === "ready" || chicken?.state === "egg_ready").length,
  };
}

// 白菜优先；没有就按种子价从便宜到贵试别的 crop_*。黑名单里的、伙伴口粮不够分的，不喂。
async function feedOrder(ctx, hungry) {
  const { config, inventory } = ctx;
  if (!ctx.inventoryKnown) return config.chickenFood ? [config.chickenFood] : [];
  const order = [];
  if (config.chickenFood && (inventory[config.chickenFood] ?? 0) > 0) order.push(config.chickenFood);
  if (config.chickenFood && (inventory[config.chickenFood] ?? 0) >= hungry) return order;
  const never = new Set(config.chickenNeverFeed);
  const others = Object.keys(inventory)
    .filter((item) => item.startsWith("crop_") && item !== config.chickenFood && !never.has(item) && inventory[item] > 0)
    .filter((item) => item !== config.petFood || inventory[item] - hungry >= 1);
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
  return undefined;
}

// ── 4. 伙伴 ───────────────────────────────────────────────
// 先读 pet status：没有伙伴、今天都陪过了、背包里没口粮，就不 tend。
async function petStep(ctx) {
  const food = ctx.config.petFood;
  if (!food) return;
  const status = await call(ctx, "pet", "status");
  if (status.kind === "unknown") return ctx.out.unsure("伙伴", `读不到状态（${status.reason}），没喂`);
  if (status.kind === "err" || !Array.isArray(status.data.pets)) return ctx.out.fail("伙伴", `读不到状态（${status.code ?? "格式不对"}），没喂`);
  const pet = status.data.pets.find((entry) => entry && entry.tended_today === false);
  if (!pet) return;
  if (ctx.inventoryKnown && (ctx.inventory[food] ?? 0) <= 0) return;

  const res = await call(ctx, "pet", `tend ${food}`);
  if (res.kind === "unknown") return ctx.out.unsure("伙伴", res.reason);
  if (res.kind === "err") return ctx.out.fail("伙伴", res.code);
  ctx.inventory[food] = (ctx.inventory[food] ?? 1) - 1;
  const name = typeof pet.name === "string" && pet.name ? pet.name : "伙伴";
  ctx.out.line(`${name}：${ctx.dry ? "会喂" : "喂了"}${labelOf(ctx, food)}`);
}
petStep.label = "伙伴";

// ── 5. 零活 ───────────────────────────────────────────────
// 零活没有可读的状态，只能打了看回包；「今天已经打工」这类回包算次数满了，静默跳过。
async function workStep(ctx) {
  const times = ctx.config.work.times;
  if (ctx.dry) {
    for (let i = 0; i < times; i += 1) await call(ctx, "garden_work");
    if (times) ctx.out.line(`零活：会试${times}次（今天打过的话会被花园拒掉）`);
    return;
  }
  let earned = 0;
  let done = 0;
  for (let i = 0; i < times; i += 1) {
    const res = await call(ctx, "garden_work");
    if (res.kind === "unknown") {
      if (done) ctx.out.line(workText(done, earned));
      return ctx.out.unsure("零活", `第${i + 1}次${res.reason}`);
    }
    if (res.kind === "err") {
      if (isWorkDone(res)) break;
      if (done) ctx.out.line(workText(done, earned));
      return ctx.out.fail("零活", res.code);
    }
    done += 1;
    if (typeof res.data.moon === "number") earned += res.data.moon;
    if (res.data.work_remaining === 0 || res.data.works_remaining === 0) break;
  }
  if (done) ctx.out.line(workText(done, earned));
}
workStep.label = "零活";

function workText(done, earned) {
  return earned ? `零活：+${earned}` : `零活：${done}次`;
}

function isWorkDone(res) {
  return WORK_DONE.test(res.code) || res.data?.work_remaining === 0 || res.data?.works_remaining === 0;
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
  // status 里的饵是 {key:"bread", quantity}（商店里才叫 bait_bread）；两种写法都认，免得重复买。
  const row = baits.find((entry) => entry?.key === bait || entry?.key === `bait_${bait}` || entry?.item === `bait_${bait}`);
  let have = typeof row?.quantity === "number" ? row.quantity : 0;
  let bought = 0;
  if (have < want) {
    const buy = await call(ctx, "fish", `buy ${bait} ${want - have}`);
    if (buy.kind === "unknown") return ctx.out.unsure("钓鱼", `买饵${want - have}条结果不确定（${buy.reason}），没重试、没钓`);
    if (buy.kind === "ok") {
      bought = want - have;
      have = want;
    } else if (have === 0) {
      return ctx.out.fail("钓鱼", `买饵失败 ${buy.code}`);
    } else {
      ctx.out.fail("买饵", `${buy.code}，用手头${have}条钓`);
    }
  }

  const n = Math.min(want, have);
  const res = await call(ctx, "fish", bait === "bread" ? `cast ${n}` : `cast ${n} ${bait}`);
  if (res.kind === "unknown") return ctx.out.unsure("钓鱼", res.reason);
  if (res.kind === "err") return ctx.out.fail("钓鱼", res.code);
  if (ctx.dry) return ctx.out.line(`钓鱼：会${bought ? `买饵${bought}条、` : ""}钓${n}杆`);

  const list = Array.isArray(res.data.casts) ? res.data.casts : [];
  const fresh = (Array.isArray(res.data.new_species) ? res.data.new_species : []).map(fishName).filter(Boolean);
  const rare = [...new Set(list.filter((entry) => entry && !entry.empty && entry.rarity && !COMMON_RARITIES.has(entry.rarity)).map(fishName).filter(Boolean))];
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
    if (ctx.dry) return ctx.out.line("蜂：会 settle（收完看门口有没有幼蜂，再决定 send）");
    honeyText = honeySummary(settle.data.honey);
    const young = Array.isArray(settle.data.young) ? settle.data.young : [];
    if (young.length) return ctx.out.line(youngLines(`蜂：${honeyText ? `${honeyText}｜` : ""}门口幼蜂${young.length}只等挑：`, young));
  }

  const hive = Array.isArray(data.hive) ? data.hive : [];
  const tripsLeft = typeof data.trips_left_today === "number" ? data.trips_left_today : 0;
  if (!hive.length || tripsLeft <= 0) return honeyText && ctx.out.line(`蜂：${honeyText}`);
  const send = await call(ctx, "bee", "send");
  const sendText = send.kind === "ok" ? (ctx.dry ? "会派出去" : `派出去了${send.data.back_in ? `，${send.data.back_in}后回` : ""}`)
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

// 出错时返回一句能放进小结的原因：优先 JSON 里的 code/error，否则用花园的原文（去掉 "Error executing tool xxx: " 前缀）。
function errorCode(raw, data) {
  const explicit = typeof data.code === "string" ? data.code : typeof data.error === "string" ? data.error : undefined;
  if (raw?.isError) return explicit ?? cleanText(data.text ?? data.message) ?? "出错（没有说明）";
  if (data.ok === false || typeof data.error === "string") return explicit ?? "出错（没有说明）";
  return undefined;
}

function cleanText(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.replace(/^\s*(MCP error -?\d+:\s*)?Error executing tool [\w-]+:\s*/u, "").trim();
  return trimmed ? trimmed.slice(0, 60) : undefined;
}

function readInventory(ctx, data) {
  const inventory = data.inventory;
  if (!inventory || typeof inventory !== "object") return;
  ctx.inventoryKnown = true;
  ctx.inventory = {};
  if (!Array.isArray(inventory)) {
    for (const [item, qty] of Object.entries(inventory)) if (typeof qty === "number") ctx.inventory[item] = qty;
  } else {
    for (const row of inventory) if (typeof row?.item === "string" && typeof row.quantity === "number") ctx.inventory[row.item] = row.quantity;
  }
}

function cropLabel(ctx, crop) {
  if (!crop) return "";
  return ctx.config.cropNames[crop] ?? ctx.cropLabels[`crop_${crop}`] ?? crop;
}

function labelOf(ctx, item) {
  return cropLabel(ctx, item.replace(/^crop_/u, ""));
}

function shortReason(error) {
  const code = error?.code ?? error?.cause?.code;
  if (typeof code === "string") return code;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out/iu.test(message) ? "超时" : message.slice(0, 40) || "连接出错";
}
