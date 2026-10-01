/** SQLite 持久层：数据集版本、头寸版本、分析配置与结果快照。 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export type ReturnType = "simple" | "log";
export type AssetKind = "asset" | "cash";

export interface DatasetVersion {
  datasetId: number;
  version: number;
  returnType: ReturnType;
  assets: { symbol: string; kind: AssetKind }[];
  dates: string[];
  /** returns[date][symbol] = 简单收益率（log 已转换） */
  returns: Map<string, Map<string, number>>;
}

export interface PositionVersion {
  positionSetId: number;
  version: number;
  holdings: Map<string, number>; // symbol -> 金额（空头为负）
}

export class DbError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "DbError";
  }
}

export class DB {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS dataset_versions (
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        version INTEGER NOT NULL,
        return_type TEXT NOT NULL CHECK (return_type IN ('simple','log')),
        note TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (dataset_id, version)
      );
      CREATE TABLE IF NOT EXISTS assets (
        dataset_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('asset','cash')),
        PRIMARY KEY (dataset_id, version, symbol),
        FOREIGN KEY (dataset_id, version) REFERENCES dataset_versions(dataset_id, version)
      );
      CREATE TABLE IF NOT EXISTS returns (
        dataset_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL,
        simple_return REAL NOT NULL,
        PRIMARY KEY (dataset_id, version, date, symbol),
        FOREIGN KEY (dataset_id, version, symbol) REFERENCES assets(dataset_id, version, symbol)
      );
      CREATE TABLE IF NOT EXISTS position_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS position_versions (
        position_set_id INTEGER NOT NULL REFERENCES position_sets(id),
        version INTEGER NOT NULL,
        note TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (position_set_id, version)
      );
      CREATE TABLE IF NOT EXISTS positions (
        position_set_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        amount REAL NOT NULL,
        PRIMARY KEY (position_set_id, version, symbol),
        FOREIGN KEY (position_set_id, version) REFERENCES position_versions(position_set_id, version)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL,
        dataset_version INTEGER NOT NULL,
        position_set_id INTEGER NOT NULL,
        position_version INTEGER NOT NULL,
        confidence REAL NOT NULL,
        bootstrap_samples INTEGER NOT NULL DEFAULT 0,
        bootstrap_seed INTEGER,
        scenario_shocks TEXT,      -- JSON: {symbol: shockSimpleReturn}
        position_scale REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (dataset_id, dataset_version) REFERENCES dataset_versions(dataset_id, version),
        FOREIGN KEY (position_set_id, position_version) REFERENCES position_versions(position_set_id, version)
      );
      CREATE TABLE IF NOT EXISTS results (
        analysis_id INTEGER PRIMARY KEY REFERENCES analyses(id),
        n INTEGER NOT NULL,
        var_loss REAL NOT NULL,
        es REAL NOT NULL,
        result_json TEXT NOT NULL,  -- 完整快照：排序样本、尾部权重、逐资产贡献、CI
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /** 创建数据集（返回 id）。同名允许，名称仅作标签。 */
  createDataset(name: string): number {
    const r = this.db.prepare("INSERT INTO datasets(name) VALUES (?)").run(name);
    return Number(r.lastInsertRowid);
  }

  /**
   * 导入新版本收益率（单事务，避免并行导入混入两版输入）。
   * rows: {date, symbol, return}[]，returnType 声明 simple/log；log 在此转换为 simple。
   * 规则：日期+symbol 重复 -> 拒绝整个版本；现金资产收益率强制为 0。
   */
  importReturns(
    datasetId: number,
    returnType: ReturnType,
    assets: { symbol: string; kind: AssetKind }[],
    rows: { date: string; symbol: string; return: number }[],
    note = ""
  ): number {
    if (returnType !== "simple" && returnType !== "log") {
      throw new DbError("INVALID_RETURN_TYPE", `收益率类型必须是 simple 或 log，收到: ${returnType}`);
    }
    const symbols = new Set(assets.map((a) => a.symbol));
    if (symbols.size !== assets.length) throw new DbError("DUPLICATE_ASSET", "资产列表存在重复代码");
    const seen = new Set<string>();
    const converted: { date: string; symbol: string; r: number }[] = [];
    for (const row of rows) {
      const key = `${row.date}|${row.symbol}`;
      if (seen.has(key)) {
        throw new DbError("DUPLICATE_DATE", `导入数据存在重复 日期+资产: ${key}，整个版本被拒绝`);
      }
      seen.add(key);
      const sym = row.symbol;
      if (!symbols.has(sym)) throw new DbError("UNKNOWN_ASSET", `收益率引用了未登记资产: ${sym}`);
      if (!Number.isFinite(row.return)) throw new DbError("NON_FINITE_RETURN", `收益率非有限值: ${key}`);
      const asset = assets.find((a) => a.symbol === sym)!;
      const r = asset.kind === "cash" ? 0 : returnType === "log" ? Math.exp(row.return) - 1 : row.return;
      converted.push({ date: row.date, symbol: sym, r });
    }
    if (converted.length === 0) throw new DbError("EMPTY_IMPORT", "导入数据为空");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const vrow = this.db
        .prepare("SELECT COALESCE(MAX(version),0)+1 AS v FROM dataset_versions WHERE dataset_id=?")
        .get(datasetId) as { v: number };
      const version = vrow.v;
      this.db.prepare("INSERT INTO dataset_versions(dataset_id,version,return_type,note) VALUES (?,?,?,?)")
        .run(datasetId, version, returnType, note);
      const insA = this.db.prepare("INSERT INTO assets(dataset_id,version,symbol,kind) VALUES (?,?,?,?)");
      for (const a of assets) insA.run(datasetId, version, a.symbol, a.kind);
      const insR = this.db.prepare("INSERT INTO returns(dataset_id,version,date,symbol,simple_return) VALUES (?,?,?,?,?)");
      for (const c of converted) insR.run(datasetId, version, c.date, c.symbol, c.r);
      this.db.exec("COMMIT");
      return version;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 数据质量检查：重复日期、缺测日期、非有限值统计 */
  qualityCheck(datasetId: number, version: number): object {
    const dv = this.getDatasetVersion(datasetId, version);
    const issues: string[] = [];
    const dup = this.db.prepare(
      "SELECT date, symbol, COUNT(*) c FROM returns WHERE dataset_id=? AND version=? GROUP BY date, symbol HAVING c>1"
    ).all(datasetId, version) as any[];
    for (const d of dup) issues.push(`重复记录: ${d.date} ${d.symbol} x${d.c}`);
    const missing: { date: string; symbol: string }[] = [];
    for (const date of dv.dates) {
      for (const a of dv.assets) {
        if (!dv.returns.get(date)?.has(a.symbol)) missing.push({ date, symbol: a.symbol });
      }
    }
    if (missing.length > 0) {
      issues.push(`缺测 ${missing.length} 条（分析时对应日期将被剔除，即 complete-case 规则）`);
    }
    return {
      datasetId, version,
      returnType: dv.returnType,
      assets: dv.assets,
      nDates: dv.dates.length,
      nRows: [...dv.returns.values()].reduce((s, m) => s + m.size, 0),
      missing,
      issues,
      ok: issues.length === 0,
    };
  }

  getDatasetVersion(datasetId: number, version: number): DatasetVersion {
    const dv = this.db.prepare("SELECT return_type FROM dataset_versions WHERE dataset_id=? AND version=?")
      .get(datasetId, version) as any;
    if (!dv) throw new DbError("VERSION_NOT_FOUND", `数据集 ${datasetId} 版本 ${version} 不存在`);
    const assets = this.db.prepare("SELECT symbol, kind FROM assets WHERE dataset_id=? AND version=? ORDER BY symbol")
      .all(datasetId, version) as any[];
    const rows = this.db.prepare("SELECT date, symbol, simple_return r FROM returns WHERE dataset_id=? AND version=? ORDER BY date")
      .all(datasetId, version) as any[];
    const returns = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!returns.has(r.date)) returns.set(r.date, new Map());
      returns.get(r.date)!.set(r.symbol, r.r);
    }
    return { datasetId, version, returnType: dv.return_type, assets, dates: [...returns.keys()], returns };
  }

  latestDatasetVersion(datasetId: number): number {
    const r = this.db.prepare("SELECT MAX(version) v FROM dataset_versions WHERE dataset_id=?").get(datasetId) as any;
    if (!r || r.v == null) throw new DbError("VERSION_NOT_FOUND", `数据集 ${datasetId} 没有任何版本`);
    return r.v;
  }

  createPositionSet(name: string): number {
    const r = this.db.prepare("INSERT INTO position_sets(name) VALUES (?)").run(name);
    return Number(r.lastInsertRowid);
  }

  /** 提交头寸新版本（单事务；金额必须有限；空头为负金额） */
  commitPositions(positionSetId: number, holdings: Record<string, number>, note = ""): number {
    const entries = Object.entries(holdings);
    if (entries.length === 0) throw new DbError("EMPTY_POSITIONS", "头寸不能为空");
    for (const [sym, amt] of entries) {
      if (!Number.isFinite(amt)) throw new DbError("NON_FINITE_AMOUNT", `头寸金额必须有限: ${sym}=${amt}`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = (this.db.prepare("SELECT COALESCE(MAX(version),0)+1 v FROM position_versions WHERE position_set_id=?")
        .get(positionSetId) as any).v;
      this.db.prepare("INSERT INTO position_versions(position_set_id,version,note) VALUES (?,?,?)")
        .run(positionSetId, v, note);
      const ins = this.db.prepare("INSERT INTO positions(position_set_id,version,symbol,amount) VALUES (?,?,?,?)");
      for (const [sym, amt] of entries) ins.run(positionSetId, v, sym, amt);
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getPositionVersion(positionSetId: number, version: number): PositionVersion {
    const rows = this.db.prepare("SELECT symbol, amount FROM positions WHERE position_set_id=? AND version=?")
      .all(positionSetId, version) as any[];
    if (rows.length === 0) throw new DbError("VERSION_NOT_FOUND", `头寸集 ${positionSetId} 版本 ${version} 不存在`);
    return { positionSetId, version, holdings: new Map(rows.map((r) => [r.symbol, r.amount])) };
  }

  latestPositionVersion(positionSetId: number): number {
    const r = this.db.prepare("SELECT MAX(version) v FROM position_versions WHERE position_set_id=?").get(positionSetId) as any;
    if (!r || r.v == null) throw new DbError("VERSION_NOT_FOUND", `头寸集 ${positionSetId} 没有任何版本`);
    return r.v;
  }

  /** 保存分析配置（冻结数据/头寸版本引用） */
  createAnalysis(cfg: {
    datasetId: number; datasetVersion: number; positionSetId: number; positionVersion: number;
    confidence: number; bootstrapSamples: number; bootstrapSeed: number | null;
    scenarioShocks: Record<string, number> | null; positionScale: number;
  }): number {
    const r = this.db.prepare(`INSERT INTO analyses
      (dataset_id,dataset_version,position_set_id,position_version,confidence,bootstrap_samples,bootstrap_seed,scenario_shocks,position_scale)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      cfg.datasetId, cfg.datasetVersion, cfg.positionSetId, cfg.positionVersion, cfg.confidence,
      cfg.bootstrapSamples, cfg.bootstrapSeed,
      cfg.scenarioShocks ? JSON.stringify(cfg.scenarioShocks) : null, cfg.positionScale);
    return Number(r.lastInsertRowid);
  }

  getAnalysis(id: number): any {
    const a = this.db.prepare("SELECT * FROM analyses WHERE id=?").get(id) as any;
    if (!a) throw new DbError("ANALYSIS_NOT_FOUND", `分析 ${id} 不存在`);
    return a;
  }

  saveResult(analysisId: number, n: number, varLoss: number, es: number, snapshot: object): void {
    this.db.prepare("INSERT INTO results(analysis_id,n,var_loss,es,result_json) VALUES (?,?,?,?,?)")
      .run(analysisId, n, varLoss, es, JSON.stringify(snapshot));
  }

  getResult(analysisId: number): any {
    const r = this.db.prepare("SELECT * FROM results WHERE analysis_id=?").get(analysisId) as any;
    if (!r) throw new DbError("RESULT_NOT_FOUND", `分析 ${analysisId} 尚无结果`);
    return { ...r, result: JSON.parse(r.result_json) };
  }

  listAnalyses(): any[] {
    return this.db.prepare(`SELECT a.*, r.var_loss, r.es, r.n FROM analyses a
      LEFT JOIN results r ON r.analysis_id=a.id ORDER BY a.id`).all() as any[];
  }
}
