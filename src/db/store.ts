import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Position, ReturnConvention, RiskResult, Scenario } from "../core/types.js";
import { RawReturnRow } from "../core/ingest.js";

export interface DatasetRecord {
  id: string;
  version: number;
  returnConvention: ReturnConvention;
  assets: string[];
  scenarios: Scenario[];
  createdAt: string;
  note: string;
}

export interface PositionSetRecord {
  id: string;
  version: number;
  positions: Position[];
  createdAt: string;
  note: string;
}

export interface AnalysisRecord {
  id: string;
  datasetId: string;
  datasetVersion: number;
  positionSetId: string;
  positionVersion: number;
  createdAt: string;
  configJson: string;
  resultJson: string;
}

/**
 * SQLite 存储。版本化数据集与头寸集合; 分析记录以快照方式保存完整结果 JSON,
 * 并显式记录所引用的数据/头寸版本, 保证旧报告在数据修订后仍可查询、结果不串版。
 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        return_convention TEXT NOT NULL,
        assets_json TEXT NOT NULL,
        scenarios_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS position_sets (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        positions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        dataset_version INTEGER NOT NULL,
        position_set_id TEXT NOT NULL,
        position_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        config_json TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_refs
        ON analyses(dataset_id, dataset_version, position_set_id, position_version);
    `);
  }

  /** 在一个串行事务里写版本, 配合应用层队列避免并行导入串版。 */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const out = fn();
      this.db.exec("COMMIT;");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK;");
      throw e;
    }
  }

  latestDatasetVersion(id: string): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM datasets WHERE id = ?")
      .get(id) as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  latestPositionVersion(id: string): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM position_sets WHERE id = ?")
      .get(id) as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  insertDataset(
    id: string,
    version: number,
    convention: ReturnConvention,
    assets: string[],
    scenarios: Scenario[],
    note: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO datasets (id, version, return_convention, assets_json, scenarios_json, created_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        version,
        convention,
        JSON.stringify(assets),
        JSON.stringify(scenarios),
        new Date().toISOString(),
        note
      );
  }

  getDataset(id: string, version?: number): DatasetRecord {
    const v = version ?? this.latestDatasetVersion(id);
    const row = this.db
      .prepare("SELECT * FROM datasets WHERE id = ? AND version = ?")
      .get(id, v) as
      | {
          id: string;
          version: number;
          return_convention: ReturnConvention;
          assets_json: string;
          scenarios_json: string;
          created_at: string;
          note: string;
        }
      | undefined;
    if (!row) throw new Error(`数据集不存在: ${id}@${v}`);
    return {
      id: row.id,
      version: row.version,
      returnConvention: row.return_convention,
      assets: JSON.parse(row.assets_json),
      scenarios: JSON.parse(row.scenarios_json),
      createdAt: row.created_at,
      note: row.note,
    };
  }

  listDatasets(): { id: string; latestVersion: number }[] {
    const rows = this.db
      .prepare("SELECT id, MAX(version) AS v FROM datasets GROUP BY id")
      .all() as { id: string; v: number }[];
    return rows.map((r) => ({ id: r.id, latestVersion: r.v }));
  }

  insertPositionSet(id: string, version: number, positions: Position[], note: string): void {
    this.db
      .prepare(
        `INSERT INTO position_sets (id, version, positions_json, created_at, note)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, version, JSON.stringify(positions), new Date().toISOString(), note);
  }

  getPositionSet(id: string, version?: number): PositionSetRecord {
    const v = version ?? this.latestPositionVersion(id);
    const row = this.db
      .prepare("SELECT * FROM position_sets WHERE id = ? AND version = ?")
      .get(id, v) as
      | {
          id: string;
          version: number;
          positions_json: string;
          created_at: string;
          note: string;
        }
      | undefined;
    if (!row) throw new Error(`头寸集合不存在: ${id}@${v}`);
    return {
      id: row.id,
      version: row.version,
      positions: JSON.parse(row.positions_json),
      createdAt: row.created_at,
      note: row.note,
    };
  }

  listPositionSets(): { id: string; latestVersion: number }[] {
    const rows = this.db
      .prepare("SELECT id, MAX(version) AS v FROM position_sets GROUP BY id")
      .all() as { id: string; v: number }[];
    return rows.map((r) => ({ id: r.id, latestVersion: r.v }));
  }

  saveAnalysis(
    id: string,
    datasetId: string,
    datasetVersion: number,
    positionSetId: string,
    positionVersion: number,
    configJson: string,
    result: RiskResult
  ): void {
    this.db
      .prepare(
        `INSERT INTO analyses
         (id, dataset_id, dataset_version, position_set_id, position_version, created_at, config_json, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        datasetId,
        datasetVersion,
        positionSetId,
        positionVersion,
        new Date().toISOString(),
        configJson,
        JSON.stringify(result)
      );
  }

  getAnalysis(id: string): AnalysisRecord {
    const row = this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as
      | {
          id: string;
          dataset_id: string;
          dataset_version: number;
          position_set_id: string;
          position_version: number;
          created_at: string;
          config_json: string;
          result_json: string;
        }
      | undefined;
    if (!row) throw new Error(`分析快照不存在: ${id}`);
    return {
      id: row.id,
      datasetId: row.dataset_id,
      datasetVersion: row.dataset_version,
      positionSetId: row.position_set_id,
      positionVersion: row.position_version,
      createdAt: row.created_at,
      configJson: row.config_json,
      resultJson: row.result_json,
    };
  }

  listAnalyses(): { id: string; datasetId: string; positionSetId: string; createdAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id, dataset_id, position_set_id, created_at FROM analyses ORDER BY created_at DESC`
      )
      .all() as { id: string; dataset_id: string; position_set_id: string; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      datasetId: r.dataset_id,
      positionSetId: r.position_set_id,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export type { RawReturnRow };
