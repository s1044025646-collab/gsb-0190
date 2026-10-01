# 投资组合历史风险与尾部损失归因后端（教学版）

离线、教学用途的投资组合历史模拟风险计算服务。输入一组资产的对齐日收益率、当前头寸金额与置信水平，计算历史模拟 VaR、Expected Shortfall（ES）与逐资产尾部损失归因。仅提供 HTTP API 与 CLI，不联网抓行情、不做投资推荐、不含期权定价或实时交易。

技术栈：TypeScript + Node.js（>= 22，使用内置 `node:sqlite` 与 `node:http`，零运行时依赖）+ SQLite。Windows 本地直接运行，无需 Docker / WSL / 外部服务。

## 快速开始

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部数值断言测试
npm start          # 启动 API（默认端口 8190，PORT 环境变量可改）
npm run demo       # 端到端演示：两组合对比 + 压力冲击 + 报告导出
```

- 端口：`PORT=9000 npm start`
- 数据目录：项目内 `data/`，数据库路径用 `RISK_DB` 环境变量指定（默认 `data/risk.db`）

## 核心约定

- **损失符号**：损失 = -P&L，正数表示亏损，负数表示盈利。全盈利样本下 VaR/ES 为负，属正常。
- **收益率类型**：导入时必须声明 `simple` 或 `log`；`log` 在导入时统一转换为简单收益率（`exp(r)-1`）后存储，禁止不转换混算。现金资产（`kind: "cash"`）收益率强制为 0，不产生损失。
- **分位数**：type-7 线性插值经验分位数（与 numpy/R 默认一致）：升序样本 `h=(n-1)*q`，`Q = x[⌊h⌋] + (h-⌊h⌋)(x[⌊h⌋+1]-x[⌊h⌋])`。
- **ES**：尾部质量 `m = n*(1-c)`，最大的 `⌊m⌋` 个损失权重为 1，边界样本取分数权重 `m-⌊m⌋`，`ES = ΣwᵢLᵢ / m`。因此天然处理：尾部概率不整除样本数（分数权重）、分位点重复（不依赖 VaR 阈值比较）、全盈利样本。
- **组合 VaR**：由组合损失分布直接计算，**绝不**把各资产 VaR 简单相加。
- **ES 归因**：资产 i 的贡献 = `Σ_tail w_t · (-P&L_{i,t}) / m`，全部资产贡献之和恒等于组合 ES（有测试断言）。
- **缺测数据**：complete-case —— 任一资产缺测的日期被整体剔除并记录在结果的 `excludedDates` 中。
- **重复日期**：同一版本内 `日期+资产` 重复将拒绝整个导入版本（事务回滚）。
- **置信区间**：固定种子（mulberry32）iid 自助抽样 percentile 区间，报告样本数、种子与方法；它是统计区间，**不是未来损失的保证**。

## 数据与版本

SQLite 表：`datasets / dataset_versions / assets / returns / position_sets / position_versions / positions / analyses / results`。

- 数据修订、头寸修订都产生**新版本**，旧版本与旧分析报告可继续查询（结果快照含排序样本、尾部权重、逐资产贡献）。
- 每次分析在 `analyses` 表中冻结引用的 `dataset_version` 与 `position_version`；导入用 `BEGIN IMMEDIATE` 单事务写入，避免并行导入把两版输入混入同一次分析。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/datasets` | 创建数据集 `{name}` |
| POST | `/datasets/:id/returns` | 导入新版本 `{returnType, assets, rows, note}` |
| GET | `/datasets/:id/quality?version=` | 数据质量检查（重复/缺测/行数） |
| POST | `/position-sets` | 创建头寸集 `{name}` |
| POST | `/position-sets/:id/positions` | 提交头寸新版本 `{holdings:{SYM:金额}}`（空头为负） |
| POST | `/analyses` | 提交分析（见下） |
| GET | `/analyses` / `/analyses/:id` | 列表 / 完整结果快照 |
| GET | `/analyses/:id/daily-losses` | 逐日损失 |
| GET | `/analyses/:id/tail-contributions` | 尾部贡献与权重 |
| GET | `/analyses/:id/export?format=json\|csv` | 导出 |
| POST | `/compare` | 工况比较 `{analysisIds:[...]}` |

提交分析示例：

```json
{
  "datasetId": 1, "datasetVersion": 1,
  "positionSetId": 1, "positionVersion": 1,
  "confidence": 0.95,
  "bootstrapSamples": 2000, "bootstrapSeed": 42,
  "scenarioShocks": {"TECH": -0.2},
  "positionScale": 1.0
}
```

`scenarioShocks` 作为一条额外情景样本进入损失分布；`positionScale` 用于头寸缩放对照（风险金额随正比例缩放，有测试断言）。

## CLI

```powershell
npm run cli -- import --name 数据名 --type simple --csv returns.csv [--cash CASH] [--dataset-id N]
npm run cli -- quality --dataset-id 1
npm run cli -- positions --name 组合A --holdings '{"TECH":300000,"BANK":-100000,"CASH":400000}'
npm run cli -- analyze --dataset-id 1 --set-id 1 --confidence 0.95 --bootstrap 2000 --seed 42 --shocks '{"TECH":-0.2}'
npm run cli -- daily --analysis-id 1
npm run cli -- tail --analysis-id 1
npm run cli -- compare --ids 1,2
npm run cli -- export --analysis-id 1 --format csv --out report.csv
npm run cli -- list
```

CSV 导入格式：表头 `date,symbol,return`。

## 错误码

`INVALID_CONFIDENCE`（置信水平不在 (0,1)）、`NO_VALID_SAMPLES`（无有效样本）、`NON_FINITE_AMOUNT` / `NON_FINITE_RETURN` / `NON_FINITE_SAMPLE`（非有限数值）、`DUPLICATE_DATE`（重复日期）、`UNKNOWN_ASSET`、`EMPTY_IMPORT`、`INVALID_RETURN_TYPE`、`VERSION_NOT_FOUND`、`ANALYSIS_NOT_FOUND` 等，均以 `{error:{code,message}}` 返回（HTTP 400）。

## 测试

`npm test` 运行 18 项独立数值断言，覆盖：手算小样本 VaR/ES、分数尾部权重、重复尾部值、全盈利样本、正比例缩放、固定种子重现、ES 归因可加、现金零损失、空头方向、完全对冲、情景样本、版本隔离、缺测剔除、log 转换与全部错误路径。

## 限制

- 历史模拟法假设历史分布代表未来，无法覆盖样本外的新型极端事件；
- 自助抽样置信区间是统计区间，不构成未来损失保证；
- 情景冲击是假设性单日样本，不模拟市场传导路径；
- 本项目仅作教学演示，不构成投资建议。
