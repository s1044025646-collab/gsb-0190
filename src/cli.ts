/** CLI：导入、质检、头寸、分析、查询、比较、导出。 */
import * as fs from "node:fs";
import { DB } from "./db";
import { Service, AnalysisRequest } from "./service";
import { toCsv } from "./export";

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      opts[key] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    }
  }
  return { cmd: cmd ?? "help", opts };
}

function parseCsvReturns(text: string): { date: string; symbol: string; return: number }[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((s) => s.trim());
  if (header.join(",") !== "date,symbol,return") {
    throw new Error("CSV 表头必须为: date,symbol,return");
  }
  return lines.slice(1).filter((l) => l.trim()).map((l) => {
    const [date, symbol, ret] = l.split(",").map((s) => s.trim());
    return { date, symbol, return: Number(ret) };
  });
}

const USAGE = `用法: npm run cli -- <命令> [选项]
  import       --name 数据集名 --type simple|log --csv 文件 [--cash 现金代码,逗号分隔] [--dataset-id N 追加新版本]
  quality      --dataset-id N [--version V]
  positions    --name 头寸集名 --holdings '{"AAA":100000,"BBB":-50000}' [--set-id N 追加新版本]
  analyze      --dataset-id N --set-id N --confidence 0.95 [--dversion V] [--pversion V]
               [--bootstrap 1000 --seed 42] [--shocks '{"AAA":-0.2}'] [--scale 1]
  daily        --analysis-id N
  tail         --analysis-id N
  compare      --ids 1,2
  export       --analysis-id N [--format json|csv] [--out 文件]
  list         列出全部分析
环境变量: RISK_DB 数据库路径(默认 data/risk.db)`;

function main(): void {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (cmd === "help" || cmd === "--help") { console.log(USAGE); return; }
  const db = new DB(process.env.RISK_DB ?? "data/risk.db");
  const svc = new Service(db);
  try {
    switch (cmd) {
      case "import": {
        const rows = parseCsvReturns(fs.readFileSync(opts.csv, "utf-8"));
        const cash = new Set((opts.cash ?? "").split(",").filter(Boolean));
        const symbols = [...new Set(rows.map((r) => r.symbol))];
        const assets = symbols.map((s) => ({ symbol: s, kind: (cash.has(s) ? "cash" : "asset") as "cash" | "asset" }));
        const datasetId = opts["dataset-id"] ? Number(opts["dataset-id"]) : db.createDataset(opts.name ?? "dataset");
        const version = db.importReturns(datasetId, opts.type as any, assets, rows, "cli import");
        console.log(JSON.stringify({ datasetId, version }));
        break;
      }
      case "quality": {
        const id = Number(opts["dataset-id"]);
        const v = opts.version ? Number(opts.version) : db.latestDatasetVersion(id);
        console.log(JSON.stringify(db.qualityCheck(id, v), null, 2));
        break;
      }
      case "positions": {
        const setId = opts["set-id"] ? Number(opts["set-id"]) : db.createPositionSet(opts.name ?? "positions");
        const version = db.commitPositions(setId, JSON.parse(opts.holdings), "cli commit");
        console.log(JSON.stringify({ positionSetId: setId, version }));
        break;
      }
      case "analyze": {
        const req: AnalysisRequest = {
          datasetId: Number(opts["dataset-id"]),
          datasetVersion: opts.dversion ? Number(opts.dversion) : undefined,
          positionSetId: Number(opts["set-id"]),
          positionVersion: opts.pversion ? Number(opts.pversion) : undefined,
          confidence: Number(opts.confidence),
          bootstrapSamples: opts.bootstrap ? Number(opts.bootstrap) : 0,
          bootstrapSeed: opts.seed ? Number(opts.seed) : undefined,
          scenarioShocks: opts.shocks ? JSON.parse(opts.shocks) : undefined,
          positionScale: opts.scale ? Number(opts.scale) : 1,
        };
        const out = svc.runAnalysis(req);
        console.log(JSON.stringify({ analysisId: out.analysisId, result: out.snapshot }, null, 2));
        break;
      }
      case "daily":
        console.log(JSON.stringify(db.getResult(Number(opts["analysis-id"])).result.dailyLosses, null, 2));
        break;
      case "tail": {
        const r = db.getResult(Number(opts["analysis-id"])).result;
        console.log(JSON.stringify({ contributions: r.contributions, tailWeights: r.tailWeights, sortedDates: r.sortedDates }, null, 2));
        break;
      }
      case "compare":
        console.log(JSON.stringify(svc.compare(opts.ids.split(",").map(Number)), null, 2));
        break;
      case "export": {
        const r = db.getResult(Number(opts["analysis-id"])).result;
        const content = opts.format === "csv" ? toCsv(r) : JSON.stringify(r, null, 2);
        if (opts.out) { fs.writeFileSync(opts.out, content); console.log(`已导出: ${opts.out}`); }
        else console.log(content);
        break;
      }
      case "list":
        console.log(JSON.stringify(db.listAnalyses(), null, 2));
        break;
      default:
        console.error(`未知命令: ${cmd}\n${USAGE}`);
        process.exitCode = 1;
    }
  } catch (e: any) {
    const code = e.code ?? "ERROR";
    console.error(JSON.stringify({ error: { code, message: e.message } }));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
