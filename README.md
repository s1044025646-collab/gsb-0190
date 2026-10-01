# 投资组合历史风险与尾部损失归因后端（ptrisk）

一个**教学用、纯离线**的投资组合历史模拟风险计算服务。输入一组资产的**对齐日收益率**、
当前**头寸金额**与**置信水平**，计算：

- 历史模拟 **VaR**（在险价值）
- **Expected Shortfall（ES / 条件尾部期望损失）**
- **尾部损失逐资产归因**（贡献之和严格等于组合 ES）

只提供 **HTTP API 与 CLI**，无前端、无行情抓取、无投资推荐、无期权定价、无实时交易。

技术栈：**TypeScript + Node.js（内置 `node:sqlite`）**，零第三方运行时依赖。
本地 Windows 运行，**不需要 Docker / WSL / 付费服务 / 外部在线 API**。

---

## 1. 符号与计算约定（务必先读）

**损失/盈亏符号（全项目统一）**

- `pnl`：正为盈利，负为亏损。
- `loss = -pnl`：**正为亏损，负为盈利**。
- VaR、ES、各资产贡献一律以“**损失为正**”报告。

**收益口径（禁止混算）**

- 导入数据集时必须显式声明 `returnConvention` 为 `"simple"`（简单收益率）或 `"log"`（对数收益率）。
- 同一数据集只能采用一种口径；系统不做简单/对数之间的静默混算。缺省或其他取值会被直接拒绝。
- 单日损益统一按 `notional × ret` 计算（多头 `+`、空头 `-`、现金 `0`）。
  对数收益在单日尺度按此一阶近似处理，且不会与简单收益混入同一计算。

**经验分位数约定（VaR）**

- 采用 **R 语言 type‑7** 约定（与 NumPy `linear`、Excel `PERCENTILE.INC` 同族）：
  升序样本 `x_(1)…x_(n)`，概率 `p` 的位置 `h=(n−1)p`，`k=floor(h)`，`g=h−k`，
  `Q(p)=x_(k+1)+g·(x_(k+2)−x_(k+1))`。
- VaR 取**损失分布的高尾分位数**：`VaR_c = Q_c(L)`（不是低尾 `Q_{1-c}`）。
- 该约定对“尾部概率不能整除样本数”给出唯一的线性插值结果；“分位点重复”时插值自然退化。

**Expected Shortfall 与分数尾部权重**

- 令尾部情景期望个数 `m = n·(1−c)`，`k=floor(m)`，`g=m−k`：
  - 损失最大的 `k` 个情景权重为 1；
  - 第 `k+1` 个情景权重为 **分数权重 `g`**；
  - 其余权重为 0。权重和恒等于 `m`。
- `ES = Σ w_i·L_i / Σ w_i`。由于每个情景的组合损失等于各资产损失贡献之和，
  **按相同权重聚合后，各资产 ES 贡献之和严格等于组合 ES**（有数值断言）。
- 并列（分位点重复）时按日期做确定性次序，加权平均不随并列内次序改变。
- **全盈利样本**：VaR/ES 为“负损失”（即该分位下仍是盈利），不报错、不强行置零。

> 注意：ES **不是**把各资产的 VaR 相加；组合 VaR 也**不是**各资产 VaR 之和
> （多资产存在分散/相关效应，见演示与测试）。

**数据质量规则（明确、不静默）**

- **日期重复**：同一 `(日期, 资产)` 出现多次 → **拒绝导入**（不覆盖、不平均），返回具体单元格。
- **资产缺测 / 非有限收益**：采用**完整案例（complete‑case）**——只要某日任一资产缺测或非有限，
  **该日整列剔除**，并在质量报告中逐一列出缺失/非有限单元格。**不做前向填充**（避免虚构历史）。
- 非法日历日期拒绝。

---

## 2. 功能

- 数据集、头寸集合、计算配置与结果快照的**版本化管理**（SQLite）。
- 数据修订 → **新版本**；分析以**快照**保存并记录所引用的数据/头寸版本，**旧报告持续可查**。
- 进程内串行写队列 + `BEGIN IMMEDIATE` 事务，**并行导入不会把两版输入混进同一结果**。
- 用户**情景冲击**（按资产加性叠加日收益）、**头寸缩放对照**（正比例）。
- **固定种子自助抽样（bootstrap）置信区间**：报告样本数、随机种子、抽样方式
  （非参数经验重抽样，有放回）。**统计区间描述抽样不确定性，绝非未来损失保证**。
- 逐日损失查询、尾部贡献、工况比较、JSON / CSV 导出。
- 错误具体化：无有效样本、置信水平越界（须严格在 `(0,1)`）、非有限金额等都返回明确错误。

---

## 3. 环境要求

- **Node.js ≥ 22**（开发与实测为 v25.5.0；用到内置 `node:sqlite`）。
- Windows 原生 PowerShell / CMD 即可，无需任何容器或子系统。

```powershell
node --version
npm install
```

## 4. 构建、测试、启动、演示

```powershell
npm run build     # TypeScript 编译到 dist/
npm test          # 编译 + 运行全部数值/存储/数据质量测试(node:test)
npm run smoke     # 编译 + HTTP 端到端冒烟测试
npm start         # 启动 HTTP API(默认 http://localhost:8787)
npm run demo      # 端到端演示: 两组头寸对比 + 压力冲击 + 自助抽样 + 导出
```

可配置项（环境变量）：

- `PORT`：HTTP 端口（默认 `8787`）。
- `PTRISK_DATA_DIR`：项目内数据目录（默认 `./data`，SQLite 与导出报告都在此）。

```powershell
$env:PORT="9000"; $env:PTRISK_DATA_DIR="./data"; npm start
```

## 5. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/datasets` · `/positions` · `/analyses` | 列表 |
| POST | `/datasets` | 导入数据集（含收益口径与长表收益） |
| POST | `/positions` | 保存头寸集合（产生新版本） |
| POST | `/analyses` | 提交分析，返回 `analysisId` 与完整结果 |
| GET | `/analyses/{id}` | 结果快照（含排序样本、尾部权重、逐资产贡献） |
| GET | `/analyses/{id}/daily-losses` | 逐日损失（按损失降序，含权重） |
| GET | `/analyses/{id}/tail-contributions` | 尾部 ES 逐资产贡献 |
| GET | `/analyses/{id}/export?format=json\|csv-daily\|csv-contrib\|csv-summary` | 导出 |

导入数据集请求体示例见 [`examples/dataset.json`](examples/dataset.json)；
头寸见 [`examples/positions.json`](examples/positions.json)；配置见 [`examples/config.json`](examples/config.json)。

```powershell
# 导入
curl.exe -X POST http://localhost:8787/datasets -H "Content-Type: application/json" --data-binary "@examples/dataset.json"
# 头寸
curl.exe -X POST http://localhost:8787/positions -H "Content-Type: application/json" `
  --data-binary '{\"id\":\"example-ps\",\"positions\":[{\"assetId\":\"EQ\",\"side\":\"long\",\"notional\":700000}]}'
# 分析
curl.exe -X POST http://localhost:8787/analyses -H "Content-Type: application/json" `
  --data-binary '{\"datasetId\":\"example-ds\",\"positionSetId\":\"example-ps\",\"config\":{\"confidence\":0.9}}'
```

### 分析配置（config）

```json
{
  "confidence": 0.95,
  "scale": 1,
  "shocks": [{ "assetId": "EQ", "shock": -0.08 }],
  "bootstrap": { "enabled": true, "samples": 1000, "ciLevel": 0.9, "seed": 20240216 }
}
```

## 6. CLI

编译后可通过 `node dist/src/cli/index.js …` 使用（`npm link` 后可用 `ptrisk`）：

```powershell
$cli = "node dist/src/cli/index.js"
& $cli import-dataset examples/dataset.json
& $cli save-positions example-ps examples/positions.json "示例头寸"
& $cli analyze example-ds example-ps examples/config.json
& $cli list analyses
& $cli daily-losses <analysisId> --csv
& $cli tail-contributions <analysisId>
& $cli export <analysisId> data/report.json --format json
```

## 7. 演示输出解读

`npm run demo` 使用 12 天三资产（股票 EQ / 债券 BD / 商品 CM）**相关收益**小样本，
在同一数据集、90% 置信下比较“激进组合”和“平衡组合（含现金）”，再对平衡组合叠加
`EQ −8%、CM −10%` 的单日压力冲击，并用固定种子 `20240216` 做 1000 次自助抽样，
最后导出到 `data/reports/`。可观察到：

- 分散化使平衡组合 VaR/ES 更低；债券在股商同跌日提供对冲。
- 各资产 ES 贡献占比之和为 100%（贡献之和 = 组合 ES）。
- 现金 ES 贡献恒为 0。
- `scale=2` 时 VaR/ES 精确变为 2 倍。
- 压力冲击显著抬高尾部；自助区间随结果一并报告样本数/种子/方式。

## 8. 历史样本法的限制（教学声明）

- 结果完全由历史样本决定，**不能保证覆盖未来从未出现过的极端损失**。
- 样本量很小时，分位数与尾部均值不稳定；自助区间只反映“用历史样本重抽样”的抽样不确定性，
  **不是对未来损失上限或收益的承诺**。
- 完整案例对齐会丢弃缺测日；长样本中市场结构、波动率与相关性会变化，历史等权重不做自适应。
- 本服务不做预测、不构成任何投资建议。

## 9. 目录结构

```
src/core/      分位数/RNG/收益对齐与质量/风险引擎(纯函数, 易测试)
src/db/        SQLite 版本化存储
src/services/  应用服务(串行写锁、分析编排、JSON/CSV)
src/http/      HTTP API
src/cli/       CLI
scripts/       demo / smoke
tests/         独立数值断言(node:test)
examples/      数据集/头寸/配置示例
data/          运行后生成: ptrisk.sqlite 与 reports/
```
