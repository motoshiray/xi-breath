# garden_daily · 月光花园每日一键

一次调用做完每天的例行事，只回一张短小结（纯文本，目标 600 字以内）。
参考了 [moonlight-garden-handytools](https://github.com/shikihuang04/moonlight-garden-handytools) 0.2.0 连花园 MCP 的写法，但没有改它，是另外写的。

## 做什么（按顺序）

1. **收菜** `farm harvest`：熟了的全收。被偷过的照常收，小结里记一句「N号地被谁薅过」。
2. **补种＋浇水**：按地块计划补种收完后空出来的地。种子缺几颗就 `buy seed_<作物> <数量>` 买几颗，然后 `water` 全浇。浇水在冷却就跳过。
3. **鸡窝**：先 `collect` 收蛋，再 `feed` 喂饿着的鸡，优先喂白菜。没有白菜就喂背包里最便宜的 `crop_*`，便宜贵按种子价来比，查不到种子价就不乱喂。伙伴的口粮只在喂完鸡还有剩的时候才拿来喂鸡。
4. **伙伴** `pet tend crop_autumn_chestnut`：背包里没栗子就跳过，今天喂过了也跳过。
5. **零活** `garden_work`，最多 3 次。次数用满了就停。
6. **钓鱼**：先看 `fish status`。今天钓满了就跳过。面包虫不够就 `buy bread <缺的条数>`，然后 `cast 10`。
7. **蜂群** `bee status`：
   - 门口有幼蜂 → **停**：不 settle、不 send、不 keep/release，只列出每只的 label、亲代、是不是新图鉴，等 Rui 挑。
   - 蜂在外面 → 跳过。
   - 回来了 → `settle` 收蜜。settle 之后门口出现幼蜂也停下列出来；门口没有、今天还有趟数，就 `send`。

最后读一次余额。

## 故意不做的事

不做菜、不卖东西、不买地/鸡/蜂箱、不买种子以外的东西（鱼饵除外），不偷菜、不摸蛋，不碰蜂的 keep / release / free / name / expand，不碰伙伴的 keep / release / name，也不调用 `kitchen` / `inventory`，所以不会回整份菜谱。

## 出错和重跑

- 每一步各自兜错，一步失败不拦后面。出错的那一步写一行 `✗ 步骤：原因`。
- 超时、断线这类结果说不准的，写成 `? 步骤：不确定（原因），没重试`，**任何一步都不自动重试**。买面包虫断线就不钓；买种子断线，那块地就先不种，下次跑的时候背包里有种子会直接种上。
- 一开始连不上花园的话，整张小结只有一句「连不上花园，今天什么都没做」。
- 同一个花园日（UTC 00:00 换日，即 JST 09:00）再跑一次，零活满了、伙伴喂过了、钓鱼满了、没东西可收的，都会静默跳过。判断全靠花园当场的回包，本地不存「今天做过什么」。
- 两个一键同时跑的话，第二个会直接拒绝。

## 安装

要求 Node.js 20 以上。

```sh
cd tools/garden-daily
npm ci
cp garden-daily.config.example.json garden-daily.config.json
```

连接信息只从环境变量读：`MOONLIGHT_GARDEN_MCP_URL` 必填（花园的 Streamable HTTP MCP 地址），`MOONLIGHT_GARDEN_MCP_TOKEN` 选填（需要 Bearer token 的时候才填）。

挂进 Claude Code（路径换成绝对路径）：

```sh
claude mcp add garden-daily \
  -e MOONLIGHT_GARDEN_MCP_URL=https://… \
  -e MOONLIGHT_GARDEN_MCP_TOKEN=… \
  -- node /绝对路径/tools/garden-daily/src/index.js --config /绝对路径/tools/garden-daily/garden-daily.config.json
```

挂好以后会多一个工具 `garden_daily`，参数只有一个可选的 `dryRun`。

## 先演练，再真跑

```sh
# 演练：只发 status / shop 查询，列出本来会执行的命令，什么都不动
node --env-file=.env src/index.js --config garden-daily.config.json --once --dry-run

# 真跑一天
node --env-file=.env src/index.js --config garden-daily.config.json --once
```

在 Claude Code 里调用 `garden_daily({"dryRun": true})` 也是演练。

## 改地块计划

改 `garden-daily.config.json` 里的 `plots` 就行，不用改代码，也不用重启（每次调用都会重读配置）：

```json
"plots": { "1": "house", "2": "cabbage", "3": "autumn_chestnut", "4": "autumn_chestnut", "5": "moonlight_rose", "6": "cabbage" }
```

- 作物名不带 `seed_`。
- `"house"` 或 `null` 表示这块地跳过。
- 买了新地却还没写进计划的话，地空着也不会去种，小结里会提一句「N号空着，不在计划里」。

其他配置项：`cropNames`（小结里显示的短名）、`chickenFood`、`petFood`（填 `null` 表示不喂伙伴）、`work.times`、`fishing.bait`、`fishing.casts`。

## 小结长这样

```
花园日 2026-10-15（UTC）
收：白菜1、秋月栗2（3号地被 Aster 薅过）
种：2白菜 3栗 4栗；浇水✓
鸡：蛋2，喂了白菜
貘：喂了秋月栗
零活：+45
钓鱼：10杆｜新：沉星鳢｜稀有：丰收神鱼
蜂：收蜜7（百花蜜6、幻光蘑菇蜜1）｜门口幼蜂1只等挑：
  1 霜白·菱格·潜根（睿蜜×沈克家小霜）新
余额：2702 moon
```

没发生的项不写。

## 测试

```sh
npm test
```

测试用的是假花园，其中一个测试会在本机起一个假的花园 MCP，再用真入口连过去跑一遍。没有碰过真花园。
