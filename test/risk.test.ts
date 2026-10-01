import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRisk, tailWeights, bootstrapCI, logToSimple, RiskError } from "../src/risk";
import { DB } from "../src/db";
import { Service } from "../src/service";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("手算小样本: n=10, c=0.9, type-7 VaR 与整数尾部 ES", () => {
  const losses = [-5, -3, -1, 0, 1, 2, 3, 4, 6, 10];
  const r = computeRisk(losses, 0.9);
  // h = 9*0.9 = 8.1 -> VaR = 6 + 0.1*(10-6) = 6.4
  close(r.varLoss, 6.4);
  // m = 1 -> ES = 10
  close(r.es, 10);
  assert.deepEqual(r.tail, [{ index: 9, weight: 1 }]);
});

test("分数尾部权重: n=10, c=0.85 -> m=1.5", () => {
  const losses = [-5, -3, -1, 0, 1, 2, 3, 4, 6, 10];
  const r = computeRisk(losses, 0.85);
  assert.deepEqual(r.tail, [
    { index: 8, weight: 0.5 },
    { index: 9, weight: 1 },
  ]);
  // ES = (0.5*6 + 1*10) / 1.5 = 8.666...
  close(r.es, 13 / 1.5);
});

test("重复尾部值: 相同最大值按权重处理", () => {
  const losses = [1, 2, 3, 10, 10];
  const r = computeRisk(losses, 0.6); // m = 2
  close(r.es, 10);
  assert.equal(r.tail.length, 2);
  assert.ok(r.tail.every((t) => t.weight === 1));
});

test("全盈利样本: VaR 与 ES 均为负", () => {
  const r = computeRisk([-10, -8, -6, -4, -2], 0.8); // m = 1
  close(r.es, -2);
  assert.ok(r.varLoss < 0);
});

test("风险金额随头寸正比例缩放", () => {
  const losses = [-5, -3, -1, 0, 1, 2, 3, 4, 6, 10];
  const r1 = computeRisk(losses, 0.9);
  const r2 = computeRisk(losses.map((x) => x * 2.5), 0.9);
  close(r2.varLoss, r1.varLoss * 2.5);
  close(r2.es, r1.es * 2.5);
});

test("固定种子自助抽样可重现", () => {
  const losses = [3, -7, 12, 0, -2, 8, -15, 5, 1, -4, 9, -11, 6, 2, -1, 14, -6, 4, -3, 7];
  const a = bootstrapCI(losses, 0.85, 500, 42);
  const b = bootstrapCI(losses, 0.85, 500, 42);
  assert.deepEqual(a, b);
  const c = bootstrapCI(losses, 0.85, 500, 43);
  assert.notDeepEqual(a.esCI, c.esCI);
  assert.equal(a.samples, 500);
  assert.equal(a.seed, 42);
});

test("错误: 置信水平越界 / 空样本 / 非有限样本", () => {
  assert.throws(() => computeRisk([1], 1), (e: any) => e.code === "INVALID_CONFIDENCE");
  assert.throws(() => computeRisk([1], 0), (e: any) => e.code === "INVALID_CONFIDENCE");
  assert.throws(() => computeRisk([1], NaN), (e: any) => e.code === "INVALID_CONFIDENCE");
  assert.throws(() => computeRisk([], 0.95), (e: any) => e.code === "NO_VALID_SAMPLES");
  assert.throws(() => computeRisk([1, Infinity], 0.95), (e: any) => e.code === "NON_FINITE_SAMPLE");
});

test("对数收益率转换: exp(r)-1", () => {
  close(logToSimple(Math.log(1.05)), 0.05);
});

// ---------- 服务层（内存 SQLite） ----------
function makeService() {
  const db = new DB(":memory:");
  return { db, svc: new Service(db) };
}

function importThreeAssets(db: DB) {
  const dsId = db.createDataset("t");
  // 4 天: AAA 与 BBB 完全相关, CASH 恒 0; 含一个极端亏损点
  const rows = [
    { date: "2024-01-01", symbol: "AAA", return: 0.01 },
    { date: "2024-01-01", symbol: "BBB", return: 0.02 },
    { date: "2024-01-01", symbol: "CASH", return: 0 },
    { date: "2024-01-02", symbol: "AAA", return: -0.05 },
    { date: "2024-01-02", symbol: "BBB", return: -0.10 },
    { date: "2024-01-02", symbol: "CASH", return: 0 },
    { date: "2024-01-03", symbol: "AAA", return: 0.02 },
    { date: "2024-01-03", symbol: "BBB", return: 0.04 },
    { date: "2024-01-03", symbol: "CASH", return: 0 },
    { date: "2024-01-04", symbol: "AAA", return: -0.01 },
    { date: "2024-01-04", symbol: "BBB", return: -0.02 },
    { date: "2024-01-04", symbol: "CASH", return: 0 },
  ];
  db.importReturns(dsId, "simple", [
    { symbol: "AAA", kind: "asset" },
    { symbol: "BBB", kind: "asset" },
    { symbol: "CASH", kind: "cash" },
  ], rows);
  return dsId;
}

test("ES 归因可加: 贡献之和等于组合 ES", () => {
  const { db, svc } = makeService();
  const dsId = importThreeAssets(db);
  const psId = db.createPositionSet("p");
  db.commitPositions(psId, { AAA: 1000, BBB: 500, CASH: 200 });
  const { snapshot } = svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.75 });
  close(snapshot.contributionSum, snapshot.es);
  const sum = snapshot.contributions.reduce((a: number, c: any) => a + c.contribution, 0);
  close(sum, snapshot.es);
});

test("现金不产生损失", () => {
  const { db, svc } = makeService();
  const dsId = importThreeAssets(db);
  const psId = db.createPositionSet("p");
  db.commitPositions(psId, { CASH: 100000 });
  const { snapshot } = svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.75 });
  close(snapshot.es, 0);
  close(snapshot.var, 0);
  assert.ok(snapshot.dailyLosses.every((d: any) => d.loss === 0));
});

test("空头方向: 资产下跌时空头盈利(损失为负)", () => {
  const { db, svc } = makeService();
  const dsId = importThreeAssets(db);
  const psId = db.createPositionSet("p");
  db.commitPositions(psId, { AAA: -1000 });
  const { snapshot } = svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.75 });
  // 2024-01-02 AAA -5% -> 空头盈利 50 -> 损失 -50
  const d2 = snapshot.dailyLosses.find((d: any) => d.date === "2024-01-02");
  close(d2.loss, -50);
  // 2024-01-03 AAA +2% -> 空头亏损 20
  const d3 = snapshot.dailyLosses.find((d: any) => d.date === "2024-01-03");
  close(d3.loss, 20);
});

test("完全对冲: 多头AAA+等额空头AAA复制腿(BBB=2*AAA) 损失为零", () => {
  const { db, svc } = makeService();
  const dsId = importThreeAssets(db);
  const psId = db.createPositionSet("p");
  // BBB 收益恒为 AAA 的 2 倍 -> 1000 多 AAA + 500 空 BBB 完全对冲
  db.commitPositions(psId, { AAA: 1000, BBB: -500 });
  const { snapshot } = svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.75 });
  assert.ok(snapshot.dailyLosses.every((d: any) => Math.abs(d.loss) < 1e-12));
  close(snapshot.es, 0);
});

test("头寸缩放对照: scale=2 时 ES 翻倍", () => {
  const { db, svc } = makeService();
  const dsId = importThreeAssets(db);
  const psId = db.createPositionSet("p");
  db.commitPositions(psId, { AAA: 1000, BBB: 500 });
  const a = svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.75 });
  const b = svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.75, positionScale: 2 });
  close(b.snapshot.es, a.snapshot.es * 2);
  close(b.snapshot.var, a.snapshot.var * 2);
});

test("情景冲击作为额外样本进入分布", () => {
  const { db, svc } = makeService();
  const dsId = importThreeAssets(db);
  const psId = db.createPositionSet("p");
  db.commitPositions(psId, { AAA: 1000 });
  const { snapshot } = svc.runAnalysis({
    datasetId: dsId, positionSetId: psId, confidence: 0.5,
    scenarioShocks: { AAA: -0.3 },
  });
  close(snapshot.scenarioLoss, 300);
  assert.equal(snapshot.nSamples, 5); // 4 历史 + 1 情景
  // 损失序列 [-10,50,-20,10,300], c=0.5 -> m=2.5 -> ES=(300+50+0.5*10)/2.5=142
  close(snapshot.es, 142);
  assert.equal(Math.max(...snapshot.sortedLossesAsc), 300); // 情景成为最大损失
});

test("版本管理: 数据修订产生新版本, 旧分析仍可查询", () => {
  const { db, svc } = makeService();
  const dsId = importThreeAssets(db);
  const psId = db.createPositionSet("p");
  db.commitPositions(psId, { AAA: 1000 });
  const a1 = svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.75 });
  // 修订数据 -> v2
  db.importReturns(dsId, "simple", [{ symbol: "AAA", kind: "asset" }],
    [{ date: "2024-01-01", symbol: "AAA", return: -0.5 }]);
  const a2 = svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.75 });
  assert.notEqual(a1.snapshot.es, a2.snapshot.es);
  const old = db.getResult(a1.analysisId).result;
  close(old.es, a1.snapshot.es); // 旧报告不变
  assert.equal(old.dataset.version, 1);
});

test("错误: 非有限金额 / 重复日期 / 未知资产", () => {
  const { db } = makeService();
  const dsId = importThreeAssets(db);
  const psId = db.createPositionSet("p");
  assert.throws(() => db.commitPositions(psId, { AAA: NaN }), (e: any) => e.code === "NON_FINITE_AMOUNT");
  assert.throws(
    () => db.importReturns(dsId, "simple", [{ symbol: "X", kind: "asset" }],
      [{ date: "2024-01-01", symbol: "X", return: 1 }, { date: "2024-01-01", symbol: "X", return: 2 }]),
    (e: any) => e.code === "DUPLICATE_DATE"
  );
  db.commitPositions(psId, { NOPE: 100 });
  const svc = new Service(db);
  assert.throws(() => svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.9 }),
    (e: any) => e.code === "UNKNOWN_ASSET");
});

test("缺测日期被剔除 (complete-case)", () => {
  const { db, svc } = makeService();
  const dsId = db.createDataset("t");
  db.importReturns(dsId, "simple", [{ symbol: "AAA", kind: "asset" }, { symbol: "BBB", kind: "asset" }], [
    { date: "2024-01-01", symbol: "AAA", return: 0.01 },
    { date: "2024-01-01", symbol: "BBB", return: 0.01 },
    { date: "2024-01-02", symbol: "AAA", return: -0.02 }, // BBB 缺测
  ]);
  const psId = db.createPositionSet("p");
  db.commitPositions(psId, { AAA: 1000, BBB: 1000 });
  const { snapshot } = svc.runAnalysis({ datasetId: dsId, positionSetId: psId, confidence: 0.5 });
  assert.equal(snapshot.nHistorical, 1);
  assert.deepEqual(snapshot.excludedDates, ["2024-01-02"]);
});

test("log 收益率导入时转换, 不与 simple 混算", () => {
  const { db } = makeService();
  const dsId = db.createDataset("t");
  db.importReturns(dsId, "log", [{ symbol: "AAA", kind: "asset" }], [
    { date: "2024-01-01", symbol: "AAA", return: Math.log(1.1) },
  ]);
  const dv = db.getDatasetVersion(dsId, 1);
  close(dv.returns.get("2024-01-01")!.get("AAA")!, 0.1);
  assert.throws(() => db.importReturns(dsId, "mixed" as any, [{ symbol: "A", kind: "asset" }], []),
    (e: any) => e.code === "INVALID_RETURN_TYPE");
});
