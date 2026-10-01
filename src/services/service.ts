import { randomUUID } from "node:crypto";
import { Store } from "../db/store.js";
import { alignReturns, QualityReport, RawReturnRow, validateConvention } from "../core/ingest.js";
import { computeRisk } from "../core/engine.js";
import {
  AnalysisConfig,
  Position,
  ReturnConvention,
  RiskResult,
  Scenario,
} from "../core/types.js";

export interface DatasetImport {
  id: string;
  returnConvention: string;
  assets: string[];
  rows: RawReturnRow[];
  note?: string;
}

export interface DailyLossRow {
  rank: number;
  date: string;
  pnl: number;
  loss: number;
  tailWeight: number;
}

export interface TailContributionRow {
  assetId: string;
  side: string;
  notional: number;
  esContribution: number;
  share: number;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = headers.join(",");
  const body = rows.map((r) => headers.map((h) => esc(r[h])).join(",")).join("\n");
  return `${head}\n${body}`;
}

/**
 * 应用服务。writeChain 作为进程内串行队列: 导入/写版本必须排队完成,
 * 与 SQLite 的 BEGIN IMMEDIATE 共同保证并行导入不会把两版输入混进同一结果。
 */
export class RiskService {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private store: Store) {}

  private serialize<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.writeChain.then(() => task());
    // 防止链因单个失败中断
    this.writeChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  importDataset(input: DatasetImport): Promise<{
    id: string;
    version: number;
    validScenarios: number;
    quality: QualityReport;
  }> {
    return this.serialize(() => {
      const convention = validateConvention(input.returnConvention);
      if (!input.assets || input.assets.length === 0) throw new Error("资产列表为空");
      if (new Set(input.assets).size !== input.assets.length) throw new Error("资产列表存在重复");
      const { scenarios, quality } = alignReturns(input.rows, input.assets);
      if (scenarios.length === 0) {
        throw new Error("无有效样本: 完整案例对齐后没有任何日期保留");
      }
      const version = this.store.latestDatasetVersion(input.id) + 1;
      this.store.transaction(() => {
        this.store.insertDataset(
          input.id,
          version,
          convention,
          input.assets,
          scenarios,
          input.note ?? ""
        );
      });
      return { id: input.id, version, validScenarios: scenarios.length, quality };
    });
  }

  savePositions(
    id: string,
    positions: Position[],
    note = ""
  ): Promise<{ id: string; version: number }> {
    return this.serialize(() => {
      if (positions.length === 0) throw new Error("头寸列表为空");
      for (const p of positions) {
        if (typeof p.notional !== "number" || !Number.isFinite(p.notional) || p.notional < 0) {
          throw new Error(`头寸金额必须为非负有限数: ${p.assetId} -> ${p.notional}`);
        }
        if (!["long", "short", "cash"].includes(p.side)) {
          throw new Error(`头寸方向非法: ${p.assetId} -> ${p.side}`);
        }
      }
      const version = this.store.latestPositionVersion(id) + 1;
      this.store.transaction(() => this.store.insertPositionSet(id, version, positions, note));
      return { id, version };
    });
  }

  runAnalysis(opts: {
    datasetId: string;
    datasetVersion?: number;
    positionSetId: string;
    positionVersion?: number;
    config: AnalysisConfig;
  }): Promise<{ analysisId: string; result: RiskResult }> {
    return this.serialize(() => {
      const ds = this.store.getDataset(opts.datasetId, opts.datasetVersion);
      const ps = this.store.getPositionSet(opts.positionSetId, opts.positionVersion);
      // 头寸可引用数据集中不存在的现金; 但非现金资产必须在数据集内
      for (const p of ps.positions) {
        if (p.side !== "cash" && !ds.assets.includes(p.assetId)) {
          throw new Error(`头寸资产 ${p.assetId} 不在数据集 ${ds.id} 中`);
        }
      }
      const result = computeRisk({
        scenarios: ds.scenarios,
        positions: ps.positions,
        config: opts.config,
        meta: {
          datasetId: ds.id,
          datasetVersion: ds.version,
          positionSetId: ps.id,
          positionVersion: ps.version,
          returnConvention: ds.returnConvention as ReturnConvention,
        },
      });
      const analysisId = randomUUID();
      this.store.transaction(() =>
        this.store.saveAnalysis(
          analysisId,
          ds.id,
          ds.version,
          ps.id,
          ps.version,
          JSON.stringify(opts.config),
          result
        )
      );
      return { analysisId, result };
    });
  }

  getResult(analysisId: string): RiskResult {
    return JSON.parse(this.store.getAnalysis(analysisId).resultJson) as RiskResult;
  }

  getConfig(analysisId: string): AnalysisConfig {
    return JSON.parse(this.store.getAnalysis(analysisId).configJson) as AnalysisConfig;
  }

  dailyLosses(analysisId: string): DailyLossRow[] {
    const r = this.getResult(analysisId);
    return r.rankedLosses.map((x) => ({
      rank: x.rank,
      date: x.date,
      pnl: round(x.pnl),
      loss: round(x.loss),
      tailWeight: round(x.tailWeight),
    }));
  }

  tailContributions(analysisId: string): TailContributionRow[] {
    const r = this.getResult(analysisId);
    return r.assetContributions.map((a) => ({
      assetId: a.assetId,
      side: a.side,
      notional: round(a.notional),
      esContribution: round(a.esContribution),
      share: round(a.share),
    }));
  }

  scenariosOf(datasetId: string, version?: number): Scenario[] {
    return this.store.getDataset(datasetId, version).scenarios;
  }

  listDatasets() {
    return this.store.listDatasets();
  }
  listPositionSets() {
    return this.store.listPositionSets();
  }
  listAnalyses() {
    return this.store.listAnalyses();
  }

  exportJson(analysisId: string): string {
    const rec = this.store.getAnalysis(analysisId);
    return JSON.stringify(
      {
        analysisId: rec.id,
        createdAt: rec.createdAt,
        references: {
          datasetId: rec.datasetId,
          datasetVersion: rec.datasetVersion,
          positionSetId: rec.positionSetId,
          positionVersion: rec.positionVersion,
        },
        config: JSON.parse(rec.configJson),
        result: JSON.parse(rec.resultJson),
      },
      null,
      2
    );
  }

  dailyLossCsv(analysisId: string): string {
    return toCsv(this.dailyLosses(analysisId) as unknown as Record<string, unknown>[]);
  }

  contributionCsv(analysisId: string): string {
    return toCsv(this.tailContributions(analysisId) as unknown as Record<string, unknown>[]);
  }

  summaryCsv(analysisId: string): string {
    const r = this.getResult(analysisId);
    const rows: Record<string, unknown>[] = [
      { metric: "confidence", value: r.confidence },
      { metric: "validSamples", value: r.validSamples },
      { metric: "tailProbability", value: r.tailProbability },
      { metric: "VaR_loss_positive", value: round(r.varLoss) },
      { metric: "ES_loss_positive", value: round(r.esLoss) },
      { metric: "allProfitable", value: r.allProfitable },
      { metric: "scale", value: r.scale },
    ];
    return toCsv(rows);
  }
}

function round(x: number): number {
  return Math.round(x * 1e12) / 1e12;
}
