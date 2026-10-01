#!/usr/bin/env node
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { Store } from "../db/store.js";
import { RiskService } from "../services/service.js";
import { AnalysisConfig, Position } from "../core/types.js";

const DATA_DIR = process.env.PTRISK_DATA_DIR
  ? resolve(process.env.PTRISK_DATA_DIR)
  : resolve(process.cwd(), "data");

function loadJsonFile(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function parsePositionsArg(arg: string): Position[] {
  // 支持文件路径, 或内联 JSON
  let raw: any;
  try {
    raw = readFileSync(arg, "utf-8");
    raw = JSON.parse(raw);
  } catch {
    raw = JSON.parse(arg);
  }
  const arr = Array.isArray(raw) ? raw : raw.positions;
  if (!Array.isArray(arr)) throw new Error("头寸需要数组或含 positions 的对象");
  return arr.map((p: any) => ({
    assetId: String(p.assetId),
    side: String(p.side) as Position["side"],
    notional: Number(p.notional),
  }));
}

function help(): void {
  console.log(`ptrisk - 投资组合历史风险与尾部损失归因 CLI

用法:
  ptrisk import-dataset <payload.json>
      payload: { id, returnConvention: "simple"|"log", assets:[...], rows:[{date,assetId,ret}], note? }
  ptrisk save-positions <id> <positions.json|内联JSON> [note]
  ptrisk analyze <datasetId> <positionSetId> <config.json> [--ds-ver N] [--ps-ver N]
  ptrisk result <analysisId>
  ptrisk daily-losses <analysisId> [--csv]
  ptrisk tail-contributions <analysisId> [--csv]
  ptrisk list datasets|positions|analyses
  ptrisk export <analysisId> <outFile> [--format json|csv-daily|csv-contrib|csv-summary]

环境变量:
  PTRISK_DATA_DIR  数据目录(默认 ./data)
`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const store = new Store(resolve(DATA_DIR, "ptrisk.sqlite"));
  const service = new RiskService(store);
  try {
    switch (cmd) {
      case "import-dataset": {
        const out = await service.importDataset(loadJsonFile(rest[0]));
        console.log(JSON.stringify(out, null, 2));
        return 0;
      }
      case "save-positions": {
        const [id, arg, note] = rest;
        const out = await service.savePositions(id, parsePositionsArg(arg), note ?? "");
        console.log(JSON.stringify(out, null, 2));
        return 0;
      }
      case "analyze": {
        const [datasetId, positionSetId, configPath, ...flags] = rest;
        const config = loadJsonFile(configPath) as AnalysisConfig;
        let dsVer: number | undefined;
        let psVer: number | undefined;
        for (let i = 0; i < flags.length; i++) {
          if (flags[i] === "--ds-ver") dsVer = Number(flags[++i]);
          if (flags[i] === "--ps-ver") psVer = Number(flags[++i]);
        }
        const out = await service.runAnalysis({
          datasetId,
          datasetVersion: dsVer,
          positionSetId,
          positionVersion: psVer,
          config,
        });
        console.log(JSON.stringify({ analysisId: out.analysisId, result: out.result }, null, 2));
        return 0;
      }
      case "result": {
        console.log(JSON.stringify(service.getResult(rest[0]), null, 2));
        return 0;
      }
      case "daily-losses": {
        if (rest[1] === "--csv") console.log(service.dailyLossCsv(rest[0]));
        else console.log(JSON.stringify(service.dailyLosses(rest[0]), null, 2));
        return 0;
      }
      case "tail-contributions": {
        if (rest[1] === "--csv") console.log(service.contributionCsv(rest[0]));
        else console.log(JSON.stringify(service.tailContributions(rest[0]), null, 2));
        return 0;
      }
      case "list": {
        if (rest[0] === "datasets") console.log(JSON.stringify(service.listDatasets(), null, 2));
        else if (rest[0] === "positions")
          console.log(JSON.stringify(service.listPositionSets(), null, 2));
        else if (rest[0] === "analyses")
          console.log(JSON.stringify(service.listAnalyses(), null, 2));
        else throw new Error(`未知列表类型: ${rest[0]}`);
        return 0;
      }
      case "export": {
        const [id, outFile, ...flags] = rest;
        let format = "json";
        for (let i = 0; i < flags.length; i++) {
          if (flags[i] === "--format") format = flags[++i];
        }
        let content = service.exportJson(id);
        let type = "application/json";
        if (format === "csv-daily") {
          content = service.dailyLossCsv(id);
          type = "text/csv";
        } else if (format === "csv-contrib") {
          content = service.contributionCsv(id);
          type = "text/csv";
        } else if (format === "csv-summary") {
          content = service.summaryCsv(id);
          type = "text/csv";
        }
        writeFileSync(outFile, content, "utf-8");
        console.log(`已导出 ${type} -> ${outFile}`);
        return 0;
      }
      default:
        help();
        return cmd ? 1 : 0;
    }
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`错误: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
);
