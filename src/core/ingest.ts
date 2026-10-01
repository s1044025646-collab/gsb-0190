import { ReturnConvention, Scenario } from "./types.js";

export interface RawReturnRow {
  date: string;
  assetId: string;
  ret: number;
}

export interface QualityReport {
  totalRows: number;
  uniqueDates: number;
  assets: string[];
  /** 每个 (date,asset) 重复出现的次数 >1 的键 */
  duplicateCells: string[];
  /** 非有限收益率的单元格 */
  nonFiniteCells: string[];
  /** 缺失(某日期缺某资产)的单元格, 键为 date|asset */
  missingCells: string[];
  /** 非法日期 */
  invalidDates: string[];
  /** 被采用的对齐规则说明 */
  alignmentRule: string;
  duplicateRule: string;
  missingRule: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * 校验收益率口径: 必须显式声明 simple 或 log, 禁止缺省混算。
 */
export function validateConvention(c: unknown): ReturnConvention {
  if (c === "simple" || c === "log") return c;
  throw new Error(
    `收益率口径必须显式声明为 "simple"(简单收益率) 或 "log"(对数收益率), 收到: ${String(c)}`
  );
}

export interface AlignResult {
  scenarios: Scenario[];
  quality: QualityReport;
}

/**
 * 将长表收益对齐为“日期 × 资产”的平衡面板。
 *
 * 规则(明确且固定):
 *  - 日期重复: 同一 (date, asset) 出现多次属于数据错误, 直接拒绝(报 duplicateCells),
 *    不做静默覆盖或平均, 避免并行导入/修订产生歧义。
 *  - 资产缺测: 采用“交集日期 + 交集资产”的完整案例(complete-case)规则——
 *    仅保留所有资产都有有限收益的日期; 任何缺失/非有限单元格都会导致该日期被剔除,
 *    并在 quality.missingCells / nonFiniteCells 中逐一列出。不做前向填充(避免引入虚假历史)。
 */
export function alignReturns(rows: RawReturnRow[], assets: string[]): AlignResult {
  const assetSet = new Set(assets);
  const dateSet = new Set<string>();
  const cellMap = new Map<string, number>();
  const duplicateCells: string[] = [];
  const nonFiniteCells: string[] = [];
  const invalidDates: string[] = [];

  for (const r of rows) {
    if (!isValidDate(r.date)) {
      invalidDates.push(`${r.date}|${r.assetId}`);
      continue;
    }
    if (!assetSet.has(r.assetId)) {
      // 未知资产忽略但不致命; 由数据集声明的资产集合为准
      continue;
    }
    dateSet.add(r.date);
    const key = `${r.date}|${r.assetId}`;
    if (cellMap.has(key)) {
      duplicateCells.push(key);
      continue;
    }
    if (typeof r.ret !== "number" || !Number.isFinite(r.ret)) {
      nonFiniteCells.push(key);
      continue;
    }
    cellMap.set(key, r.ret);
  }

  if (invalidDates.length > 0) {
    throw new Error(`存在非法日期: ${invalidDates.slice(0, 5).join(", ")}`);
  }
  if (duplicateCells.length > 0) {
    throw new Error(
      `检测到重复的 (日期, 资产) 单元格, 已拒绝导入: ${duplicateCells.slice(0, 5).join(", ")}`
    );
  }

  const missingCells: string[] = [];
  const scenarios: Scenario[] = [];
  const sortedDates = [...dateSet].sort();
  for (const date of sortedDates) {
    const returns: Record<string, number> = {};
    let complete = true;
    for (const a of assets) {
      const key = `${date}|${a}`;
      const v = cellMap.get(key);
      if (v === undefined) {
        missingCells.push(key);
        complete = false;
        break;
      }
      returns[a] = v;
    }
    if (complete) scenarios.push({ date, returns });
  }

  const quality: QualityReport = {
    totalRows: rows.length,
    uniqueDates: dateSet.size,
    assets: [...assets],
    duplicateCells,
    nonFiniteCells,
    missingCells,
    invalidDates,
    alignmentRule: "完整案例(complete-case): 仅保留所有资产均有有限收益的日期, 不做前向填充",
    duplicateRule: "同一(日期,资产)重复即拒绝导入, 不静默覆盖",
    missingRule: "任一资产缺测或非有限, 该日期整列剔除并记录",
  };
  return { scenarios, quality };
}
