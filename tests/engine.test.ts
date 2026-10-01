import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRisk } from "../src/core/engine.js";
import { quantileType7 } from "../src/core/quantile.js";
import { mulberry32 } from "../src/core/rng.js";
import { Position, RiskResult, Scenario } from "../src/core/types.js";

function scenario(returns: number[], dates?: string[]): Scenario[] {
  return returns.map((r, i) => ({
    date: dates?.[i] ?? `2024-01-${String(i + 1).padStart(2, "0")}`,
    returns: { A: r },
  }));
}

const longA = (notional: number): Position[] => [{ assetId: "A", side: "long", notional }];

const meta = {
  datasetId: "d",
  datasetVersion: 1,
  positionSetId: "p",
  positionVersion: 1,
  returnConvention: "simple" as const,
};

test("R-7 分位数: 1..10 在 p=0.05 插值为 1.45", () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.ok(Math.abs(quantileType7(x, 0.05) - 1.45) < 1e-12);
  assert.equal(quantileType7(x, 0), 1);
  assert.equal(quantileType7(x, 1), 10);
});

test("手算 10 样本: VaR=9.1 且 ES=9 (分数尾部权重)", () => {
  // 收益率对应损失(100 多头, loss=-100*ret): 10,8,6,4,2,0,-2,-4,-6,-8
  const rets = [-0.1, -0.08, -0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06, 0.08];
  const r = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.95 },
    meta,
  });
  // 损失升序, c=.95 => h=8.55, VaR=0.45*x9+0.55*x10=0.45*8+0.55*10=9.1
  assert.ok(Math.abs(r.varLoss - 9.1) < 1e-9, `VaR=${r.varLoss}`);
  // m=10*0.05=0.5, k=0,g=0.5 => 仅最大损失 10 权重 0.5 => ES=10
  assert.ok(Math.abs(r.esLoss - 10) < 1e-9, `ES=${r.esLoss}`);
  // 尾部权重和应等于 n*p = 0.5
  const wsum = r.rankedLosses.reduce((s, x) => s + x.tailWeight, 0);
  assert.ok(Math.abs(wsum - 0.5) < 1e-9);
  // 第 1 名分数权重 0.5, 无全权重情景
  assert.ok(Math.abs(r.rankedLosses[0].tailWeight - 0.5) < 1e-9);
  assert.ok(Math.abs(r.rankedLosses[1].tailWeight) < 1e-9);
});

test("重复尾部值: 分位点重复时 ES 仍正确且权重一致", () => {
  // n=20, c=0.95 => h=18.05, VaR=0.95*loss(x19)+0.05*loss(x20)
  // losses asc 前 18 个为 -1, 第 19、20(1基) 分别为 10、20
  // => VaR = 0.95*10 + 0.05*20 = 10.5
  const rets: number[] = [];
  for (let i = 0; i < 18; i++) rets.push(0.01); // loss = -1
  rets.push(-0.1); // loss 10
  rets.push(-0.2); // loss 20
  const r = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.95 },
    meta,
  });
  assert.ok(Math.abs(r.varLoss - 10.5) < 1e-9, `VaR=${r.varLoss}`);
  // m=20*0.05=1, k=1,g=0 => 最大损失 20 全权重 => ES=20
  const wsum = r.rankedLosses.reduce((s, x) => s + x.tailWeight, 0);
  assert.ok(Math.abs(wsum - 1) < 1e-9, `wsum=${wsum}`);
  assert.ok(Math.abs(r.esLoss - 20) < 1e-9, `ES=${r.esLoss}`);

  // 另造“分位点重复”: 两个相同尾部值, n=20 c=0.9, m=2
  const rets2: number[] = [];
  for (let i = 0; i < 18; i++) rets2.push(0.01);
  rets2.push(-0.1, -0.1); // 两个 loss=10
  const r2 = computeRisk({
    scenarios: scenario(rets2),
    positions: longA(100),
    config: { confidence: 0.9 },
    meta,
  });
  const w2 = r2.rankedLosses.reduce((s, x) => s + x.tailWeight, 0);
  assert.ok(Math.abs(w2 - 2) < 1e-9);
  assert.ok(Math.abs(r2.esLoss - 10) < 1e-9);
});

test("全盈利样本: VaR/ES 为负损失(即不要求资本), 不报错", () => {
  const rets = [0.01, 0.02, 0.03, 0.04, 0.05];
  const r = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.95 },
    meta,
  });
  assert.equal(r.allProfitable, true);
  assert.ok(r.varLoss < 0, `VaR 应为负(盈利), 实际 ${r.varLoss}`);
  assert.ok(r.esLoss < 0);
});

test("完全对冲: 多空等额同资产, 组合损失恒为 0", () => {
  const rets = [-0.1, 0.05, 0.2, -0.3];
  const positions: Position[] = [
    { assetId: "A", side: "long", notional: 100 },
    { assetId: "A2", side: "short", notional: 100 },
  ];
  // 两个资产收益完全相同
  const scenarios = rets.map((r, i) => ({
    date: `d${i}`,
    returns: { A: r, A2: r },
  }));
  const r = computeRisk({
    scenarios,
    positions,
    config: { confidence: 0.9 },
    meta,
  });
  assert.ok(Math.abs(r.varLoss) < 1e-9);
  assert.ok(Math.abs(r.esLoss) < 1e-9);
});

test("现金不产生损失且贡献为 0", () => {
  const rets = [-0.1, -0.2, 0.05];
  const positions: Position[] = [
    { assetId: "A", side: "long", notional: 100 },
    { assetId: "CASH", side: "cash", notional: 500 },
  ];
  const scenarios = rets.map((r, i) => ({
    date: `d${i}`,
    returns: { A: r, CASH: 0 },
  }));
  const r = computeRisk({
    scenarios,
    positions,
    config: { confidence: 0.9 },
    meta,
  });
  const cash = r.assetContributions.find((a) => a.assetId === "CASH")!;
  assert.equal(cash.esContribution, 0);
  const a = r.assetContributions.find((x) => x.assetId === "A")!;
  assert.ok(Math.abs(a.esContribution - r.esLoss) < 1e-9);
});

test("空头方向: 资产下跌时空头盈利(损失为负)", () => {
  const rets = [-0.1, -0.2, 0.15];
  const r = computeRisk({
    scenarios: scenario(rets),
    positions: [{ assetId: "A", side: "short", notional: 100 }],
    config: { confidence: 0.9 },
    meta,
  });
  // 空头 loss = +100*ret; 最大损失来自上涨 +15% => 15
  assert.ok(Math.abs(r.rankedLosses[0].loss - 15) < 1e-9);
});

test("分数尾部权重 k>=1: n=15 c=0.9, m=1.5 => ES=(L1+0.5*L2)/1.5", () => {
  // 损失序列(100 多头): 30,20, 其余为负盈利
  const rets: number[] = [-0.3, -0.2];
  for (let i = 0; i < 13; i++) rets.push(0.01);
  const r = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.9 },
    meta,
  });
  // ES = (30 + 0.5*20)/1.5 = 26.666...
  assert.ok(Math.abs(r.esLoss - (30 + 10) / 1.5) < 1e-9, `ES=${r.esLoss}`);
  assert.ok(Math.abs(r.rankedLosses[0].tailWeight - 1) < 1e-9);
  assert.ok(Math.abs(r.rankedLosses[1].tailWeight - 0.5) < 1e-9);
  assert.ok(Math.abs(r.rankedLosses[2].tailWeight) < 1e-9);
});

test("正比例缩放: 风险随 scale 线性变化", () => {
  const rets = [-0.1, -0.08, -0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06, 0.08];
  const base = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.95 },
    meta,
  });
  const scaled = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.95, scale: 2.5 },
    meta,
  });
  assert.ok(Math.abs(scaled.varLoss - 2.5 * base.varLoss) < 1e-9);
  assert.ok(Math.abs(scaled.esLoss - 2.5 * base.esLoss) < 1e-9);
});

test("ES 归因可加: 各资产贡献之和等于组合 ES", () => {
  const scenarios: Scenario[] = [
    { date: "d1", returns: { A: -0.1, B: -0.2 } },
    { date: "d2", returns: { A: -0.05, B: 0.1 } },
    { date: "d3", returns: { A: 0.2, B: -0.15 } },
    { date: "d4", returns: { A: 0.02, B: 0.03 } },
  ];
  const positions: Position[] = [
    { assetId: "A", side: "long", notional: 100 },
    { assetId: "B", side: "long", notional: 100 },
  ];
  const r = computeRisk({
    scenarios,
    positions,
    config: { confidence: 0.75 },
    meta,
  });
  const sum = r.assetContributions.reduce((s, a) => s + a.esContribution, 0);
  assert.ok(Math.abs(sum - r.esLoss) < 1e-9, `sum=${sum} ES=${r.esLoss}`);
});

test("固定种子自助法可重现", () => {
  const rets = [-0.1, -0.08, -0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06, 0.08];
  const bs = { enabled: true, samples: 200, ciLevel: 0.9, seed: 42 } as const;
  const r1 = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.95, bootstrap: { ...bs } },
    meta,
  });
  const r2 = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.95, bootstrap: { ...bs } },
    meta,
  });
  assert.deepEqual(r1.bootstrap!.varCi, r2.bootstrap!.varCi);
  assert.deepEqual(r1.bootstrap!.esCi, r2.bootstrap!.esCi);
  assert.equal(r1.bootstrap!.sampleSize, 10);
  assert.equal(r1.bootstrap!.seed, 42);
  assert.ok(r1.bootstrap!.varCi[0] <= r1.bootstrap!.varCi[1]);
});

test("mulberry32 种子确定性", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

test("错误: 置信水平越界 / 非有限金额 / 无样本", () => {
  const rets = [-0.1, 0.02];
  assert.throws(
    () =>
      computeRisk({
        scenarios: scenario(rets),
        positions: longA(100),
        config: { confidence: 1 },
        meta,
      }),
    /置信水平/
  );
  assert.throws(
    () =>
      computeRisk({
        scenarios: scenario(rets),
        positions: [{ assetId: "A", side: "long", notional: NaN }],
        config: { confidence: 0.95 },
        meta,
      }),
    /非负有限数/
  );
  assert.throws(
    () =>
      computeRisk({
        scenarios: [],
        positions: longA(100),
        config: { confidence: 0.95 },
        meta,
      }),
    /无有效样本/
  );
});

test("冲击叠加: 加性 -0.2 冲击放大尾部损失", () => {
  const rets = [0.01, 0.02, 0.03, 0.04];
  const base = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.9 },
    meta,
  });
  const shocked = computeRisk({
    scenarios: scenario(rets),
    positions: longA(100),
    config: { confidence: 0.9, shocks: [{ assetId: "A", shock: -0.2 }] },
    meta,
  });
  assert.ok(shocked.esLoss > base.esLoss);
  // 每个情景损失恰增加 20
  assert.ok(Math.abs(shocked.esLoss - (base.esLoss + 20)) < 1e-9);
});

