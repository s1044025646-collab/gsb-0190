/**
 * 演示：两组头寸在同一数据集下的尾部风险对比 + 压力冲击 + 报告导出。
 * 运行: npm run demo
 */
import * as fs from "node:fs";
import { DB } from "./db";
import { Service } from "./service";
import { toCsv } from "./export";
import { mulberry32 } from "./risk";

const DB_FILE = "data/demo.db";
fs.rmSync(DB_FILE, { force: true });
fs.mkdirSync("data/reports", { recursive: true });

const db = new DB(DB_FILE);
const svc = new Service(db);

// 1) 构造 60 日三资产数据集：TECH 与 BANK 正相关，CASH 恒 0；含极端亏损点与重复尾部值
const rand = mulberry32(20261001);
const assets = [
  { symbol: "TECH", kind: "asset" as const },
  { symbol: "BANK", kind: "asset" as const },
  { symbol: "CASH", kind: "cash" as const },
];
const rows: { date: string; symbol: string; return: number }[] = [];
for (let i = 0; i < 60; i++) {
  const date = `2024-${String(1 + Math.floor(i / 22)).padStart(2, "0")}-${String((i % 22) + 1).padStart(2, "0")}`;
  const market = (rand() - 0.5) * 0.04;
  let tech = market + (rand() - 0.5) * 0.02;
  let bank = market * 0.8 + (rand() - 0.5) * 0.015;
  if (i === 37) { tech = -0.12; bank = -0.09; } // 极端亏损点
  if (i === 41) { tech = -0.06; bank = -0.045; }
  if (i === 42) { tech = -0.06; bank = -0.045; } // 重复尾部值
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  rows.push({ date, symbol: "TECH", return: r(tech) });
  rows.push({ date, symbol: "BANK", return: r(bank) });
  rows.push({ date, symbol: "CASH", return: 0 });
}
const dsId = db.createDataset("demo-60d");
db.importReturns(dsId, "simple", assets, rows, "演示数据 v1");
console.log(`数据集 ${dsId} v1 导入完成（60 日 x 3 资产, simple 收益率）`);
console.log("质检:", JSON.stringify((db.qualityCheck(dsId, 1) as any).issues));

// 2) 两组头寸
const psA = db.createPositionSet("均衡组合");
db.commitPositions(psA, { TECH: 300000, BANK: 300000, CASH: 400000 });
const psB = db.createPositionSet("重仓科技+空头对冲");
db.commitPositions(psB, { TECH: 800000, BANK: -200000, CASH: 400000 });

// 3) 同一数据集下分别分析（含固定种子自助区间）
const a1 = svc.runAnalysis({ datasetId: dsId, positionSetId: psA, confidence: 0.95, bootstrapSamples: 2000, bootstrapSeed: 42 });
const a2 = svc.runAnalysis({ datasetId: dsId, positionSetId: psB, confidence: 0.95, bootstrapSamples: 2000, bootstrapSeed: 42 });
console.log(`\n[均衡组合]  VaR95=${a1.snapshot.var.toFixed(2)}  ES95=${a1.snapshot.es.toFixed(2)}`);
console.log(`[重仓科技]  VaR95=${a2.snapshot.var.toFixed(2)}  ES95=${a2.snapshot.es.toFixed(2)}`);
console.log("\n工况比较:");
console.log(JSON.stringify(svc.compare([a1.analysisId, a2.analysisId]), null, 2));

// 4) 对重仓组合施加压力冲击（TECH -20%, BANK -12%）并导出报告
const a3 = svc.runAnalysis({
  datasetId: dsId, positionSetId: psB, confidence: 0.95,
  bootstrapSamples: 2000, bootstrapSeed: 42,
  scenarioShocks: { TECH: -0.2, BANK: -0.12 },
});
console.log(`\n[重仓科技+压力冲击] 情景单日损失=${a3.snapshot.scenarioLoss?.toFixed(2)}  ES95=${a3.snapshot.es.toFixed(2)}`);
fs.writeFileSync("data/reports/stress_report.json", JSON.stringify(a3.snapshot, null, 2));
fs.writeFileSync("data/reports/stress_report.csv", toCsv(a3.snapshot));
console.log("报告已导出: data/reports/stress_report.json / .csv");

console.log(`
历史模拟法的限制（务必阅读）：
- 假设历史收益分布代表未来，无法覆盖样本外的新型极端事件；
- 置信区间是固定种子自助抽样的统计区间，不是未来损失的保证；
- 情景冲击是假设性单日样本，不代表真实市场传导路径；
- 本工具仅作教学，不构成任何投资建议。`);
db.close();
