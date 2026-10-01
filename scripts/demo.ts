/**
 * 端到端演示:
 *  1) 导入多资产(含相关性)的简单收益率数据集
 *  2) 在同一数据集下比较两组头寸的尾部风险与贡献
 *  3) 加入一次压力冲击并做固定种子自助抽样
 *  4) 导出 JSON / CSV 报告到 data/reports
 *
 * 运行: npm run demo
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/db/store.js";
import { RiskService } from "../src/services/service.js";
import { Position } from "../src/core/types.js";

const DATA_DIR = process.env.PTRISK_DATA_DIR
  ? resolve(process.env.PTRISK_DATA_DIR)
  : resolve(process.cwd(), "data");
const REPORT_DIR = resolve(DATA_DIR, "reports");
mkdirSync(REPORT_DIR, { recursive: true });

// 三资产相关日收益(简单收益率), 手工构造的小样本, 含一个共同暴跌日
const dates = [
  "2024-02-01",
  "2024-02-02",
  "2024-02-05",
  "2024-02-06",
  "2024-02-07",
  "2024-02-08",
  "2024-02-09",
  "2024-02-12",
  "2024-02-13",
  "2024-02-14",
  "2024-02-15",
  "2024-02-16",
];

// 行: [股票(EQ), 债券(BD), 商品(CM)]
const matrix: number[][] = [
  [0.004, 0.001, 0.006],
  [-0.002, 0.002, -0.004],
  [-0.038, -0.012, -0.045], // 共同暴跌(相关尾部)
  [0.011, 0.003, 0.002],
  [-0.006, 0.000, -0.01],
  [0.008, 0.001, 0.015],
  [-0.015, -0.004, 0.004],
  [0.002, 0.002, -0.006],
  [-0.024, 0.005, -0.02], // 股商同跌、债券上涨(分散)
  [0.006, -0.001, 0.009],
  [-0.004, 0.001, -0.012],
  [0.01, 0.002, 0.003],
];

const assets = ["EQ", "BD", "CM"];
const rows = dates.flatMap((date, i) =>
  assets.map((assetId, j) => ({ date, assetId, ret: matrix[i][j] }))
);

const aggressive: Position[] = [
  { assetId: "EQ", side: "long", notional: 600000 },
  { assetId: "BD", side: "long", notional: 100000 },
  { assetId: "CM", side: "long", notional: 300000 },
];

const balanced: Position[] = [
  { assetId: "EQ", side: "long", notional: 300000 },
  { assetId: "BD", side: "long", notional: 500000 },
  { assetId: "CM", side: "long", notional: 100000 },
  { assetId: "CASH", side: "cash", notional: 100000 },
];

function fmt(x: number): string {
  return x.toLocaleString("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

async function main(): Promise<void> {
  const store = new Store(resolve(DATA_DIR, "ptrisk.sqlite"));
  const svc = new RiskService(store);
  try {
    const ds = await svc.importDataset({
      id: "demo-corr",
      returnConvention: "simple",
      assets,
      rows,
      note: "三资产相关收益教学样本",
    });
    console.log(`导入数据集 demo-corr@${ds.version}, 有效情景 ${ds.validScenarios} 天`);

    const pa = await svc.savePositions("demo-aggressive", aggressive, "激进组合");
    const pb = await svc.savePositions("demo-balanced", balanced, "平衡组合(含现金)");

    const confidence = 0.9;
    const base = { confidence };

    const a = await svc.runAnalysis({
      datasetId: "demo-corr",
      positionSetId: "demo-aggressive",
      config: base,
    });
    const b = await svc.runAnalysis({
      datasetId: "demo-corr",
      positionSetId: "demo-balanced",
      config: base,
    });

    console.log("\n=== 同数据集、90% 置信、两组头寸对比 ===");
    for (const [name, res] of [
      ["激进组合", a.result],
      ["平衡组合", b.result],
    ] as const) {
      console.log(`\n[${name}] VaR=${fmt(res.varLoss)}  ES=${fmt(res.esLoss)} (损失为正)`);
      for (const c of res.assetContributions) {
        console.log(
          `   ${c.assetId.padEnd(4)} (${c.side.padEnd(4)}) ES贡献=${fmt(c.esContribution)}  占比=${(
            c.share * 100
          ).toFixed(1)}%`
        );
      }
    }

    // 压力冲击: 股票 -8%、商品 -10% 的单日加性冲击 + 固定种子自助抽样
    const stressed = await svc.runAnalysis({
      datasetId: "demo-corr",
      positionSetId: "demo-balanced",
      config: {
        confidence,
        shocks: [
          { assetId: "EQ", shock: -0.08 },
          { assetId: "CM", shock: -0.1 },
        ],
        bootstrap: { enabled: true, samples: 1000, ciLevel: 0.9, seed: 20240216 },
      },
    });
    const s = stressed.result;
    console.log("\n=== 平衡组合 + 压力冲击(EQ -8%, CM -10%) + 自助抽样 ===");
    console.log(`VaR=${fmt(s.varLoss)}  ES=${fmt(s.esLoss)}`);
    console.log(
      `VaR 90%区间=[${fmt(s.bootstrap!.varCi[0])}, ${fmt(s.bootstrap!.varCi[1])}]  ` +
        `ES 90%区间=[${fmt(s.bootstrap!.esCi[0])}, ${fmt(s.bootstrap!.esCi[1])}]`
    );
    console.log(
      `自助法: ${s.bootstrap!.method}, samples=${s.bootstrap!.samples}, ` +
        `sampleSize=${s.bootstrap!.sampleSize}, seed=${s.bootstrap!.seed}`
    );
    console.log("注意: 统计区间描述抽样不确定性, 不是对未来最大损失的保证。");

    // 导出
    writeFileSync(
      resolve(REPORT_DIR, "stressed.json"),
      svc.exportJson(stressed.analysisId),
      "utf-8"
    );
    writeFileSync(
      resolve(REPORT_DIR, "aggressive-daily.csv"),
      svc.dailyLossCsv(a.analysisId),
      "utf-8"
    );
    writeFileSync(
      resolve(REPORT_DIR, "balanced-contrib.csv"),
      svc.contributionCsv(b.analysisId),
      "utf-8"
    );
    writeFileSync(
      resolve(REPORT_DIR, "stressed-summary.csv"),
      svc.summaryCsv(stressed.analysisId),
      "utf-8"
    );
    console.log(`\n报告已导出到 ${REPORT_DIR}`);

    // 头寸缩放对照演示
    const scaled = await svc.runAnalysis({
      datasetId: "demo-corr",
      positionSetId: "demo-balanced",
      config: { confidence, scale: 2 },
    });
    console.log(
      `\n缩放校验: 平衡组合 scale=2 时 ES=${fmt(scaled.result.esLoss)} ` +
        `(基准 ES=${fmt(b.result.esLoss)}, 比值=${(scaled.result.esLoss / b.result.esLoss).toFixed(3)})`
    );
  } finally {
    store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
