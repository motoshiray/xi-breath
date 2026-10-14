import { readFile } from "node:fs/promises";

export const DEFAULT_CONFIG = {
  // 地块计划：地号 → 作物（不带 seed_）。"house" 或 null 表示跳过。
  plots: { 1: "house", 2: "cabbage", 3: "autumn_chestnut", 4: "autumn_chestnut", 5: "moonlight_rose" },
  // 小结里用的短名；没写的作物用上游返回的名字或 ID。
  cropNames: { cabbage: "白菜", autumn_chestnut: "栗", moonlight_rose: "玫瑰" },
  chickenFood: "crop_cabbage",
  petFood: "crop_autumn_chestnut",
  work: { times: 3 },
  fishing: { bait: "bread", casts: 10 },
};

export async function loadConfig(file) {
  if (!file) return DEFAULT_CONFIG;
  let input;
  try {
    input = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(error?.code === "ENOENT" ? `找不到配置文件：${file}` : `配置文件不是合法 JSON：${file}`);
  }
  const config = {
    ...DEFAULT_CONFIG,
    ...input,
    cropNames: { ...DEFAULT_CONFIG.cropNames, ...(input.cropNames ?? {}) },
    work: { ...DEFAULT_CONFIG.work, ...(input.work ?? {}) },
    fishing: { ...DEFAULT_CONFIG.fishing, ...(input.fishing ?? {}) },
  };
  validate(config);
  return config;
}

function validate(config) {
  if (!config.plots || typeof config.plots !== "object" || Array.isArray(config.plots)) throw new Error("配置 plots 必须是 {地号: 作物} 对象。");
  for (const [plot, crop] of Object.entries(config.plots)) {
    if (!/^[1-9]\d*$/u.test(plot)) throw new Error(`配置 plots 的地号不对：${plot}`);
    if (crop !== null && (typeof crop !== "string" || !/^[a-z0-9_]+$/u.test(crop) || crop.startsWith("seed_"))) {
      throw new Error(`配置 plots.${plot} 应是不带 seed_ 的作物名（如 cabbage），或 "house" / null。`);
    }
  }
  for (const key of ["chickenFood", "petFood"]) {
    if (config[key] !== null && (typeof config[key] !== "string" || !config[key].startsWith("crop_"))) throw new Error(`配置 ${key} 应是 crop_* 或 null。`);
  }
  if (!Number.isInteger(config.work.times) || config.work.times < 0 || config.work.times > 10) throw new Error("配置 work.times 应是 0–10 的整数。");
  if (!Number.isInteger(config.fishing.casts) || config.fishing.casts < 0 || config.fishing.casts > 50) throw new Error("配置 fishing.casts 应是 0–50 的整数。");
  if (typeof config.fishing.bait !== "string" || !/^[a-z]+$/u.test(config.fishing.bait)) throw new Error("配置 fishing.bait 应是鱼饵 key（如 bread）。");
}
