import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.js";
import { RiskService } from "../src/services/service.js";
import { Position } from "../src/core/types.js";

let dir: string;
let store: Store;
let service: RiskService;

const rows = [
  { date: "2024-01-01", assetId: "A", ret: -0.1 },
  { date: "2024-01-02", assetId: "A", ret: -0.2 },
  { date: "2024-01-03", assetId: "A", ret: 0.15 },
  { date: "2024-01-04", assetId: "A", ret: 0.05 },
];

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ptrisk-"));
  store = new Store(join(dir, "t.sqlite"));
  service = new RiskService(store);
});

after(() => store.close());

test("数据修订产生新版本, 旧分析快照仍可查询", async () => {
  const v1 = await service.importDataset({
    id: "ds",
    returnConvention: "simple",
    assets: ["A"],
    rows,
  });
  assert.equal(v1.version, 1);

  const positions: Position[] = [{ assetId: "A", side: "long", notional: 100 }];
  const pv = await service.savePositions("ps", positions);
  assert.equal(pv.version, 1);

  const a1 = await service.runAnalysis({
    datasetId: "ds",
    datasetVersion: 1,
    positionSetId: "ps",
    config: { confidence: 0.75 },
  });
  const esV1 = a1.result.esLoss;

  // 修订数据(追加更极端损失) => 新版本
  const v2 = await service.importDataset({
    id: "ds",
    returnConvention: "simple",
    assets: ["A"],
    rows: [...rows, { date: "2024-01-05", assetId: "A", ret: -0.4 }],
  });
  assert.equal(v2.version, 2);

  // 旧快照内容不随新版本改变
  const old = service.getResult(a1.analysisId);
  assert.equal(old.datasetVersion, 1);
  assert.ok(Math.abs(old.esLoss - esV1) < 1e-12);
  assert.equal(old.validSamples, 4);

  // 新版本分析结果不同
  const a2 = await service.runAnalysis({
    datasetId: "ds",
    datasetVersion: 2,
    positionSetId: "ps",
    config: { confidence: 0.75 },
  });
  assert.equal(a2.result.validSamples, 5);
  assert.notEqual(a2.result.esLoss, esV1);
});

test("逐日损失与尾部贡献可查询, CSV 可导出", async () => {
  const a = await service.runAnalysis({
    datasetId: "ds",
    datasetVersion: 1,
    positionSetId: "ps",
    config: { confidence: 0.5 },
  });
  const daily = service.dailyLosses(a.analysisId);
  assert.equal(daily.length, 4);
  // 排序后第一应为最大损失 20(ret -0.2 * 100)
  assert.ok(Math.abs(daily[0].loss - 20) < 1e-9);
  assert.equal(daily[0].date, "2024-01-02");
  const csv = service.dailyLossCsv(a.analysisId);
  assert.match(csv, /rank,date,pnl,loss,tailWeight/);
});

test("并行导入被串行化, 版本号不串版", async () => {
  const results = await Promise.all(
    [1, 2, 3].map((i) =>
      service.importDataset({
        id: `par${i}`,
        returnConvention: "log",
        assets: ["A"],
        rows,
      })
    )
  );
  assert.deepEqual(
    results.map((r) => r.version),
    [1, 1, 1]
  );
});
