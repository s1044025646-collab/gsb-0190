import { test } from "node:test";
import assert from "node:assert/strict";
import { alignReturns, validateConvention } from "../src/core/ingest.js";

const rows = (pairs: [string, string, number][]) =>
  pairs.map(([date, assetId, ret]) => ({ date, assetId, ret }));

test("必须声明收益率口径", () => {
  assert.throws(() => validateConvention(undefined), /收益率口径/);
  assert.throws(() => validateConvention("pct"), /收益率口径/);
  assert.equal(validateConvention("simple"), "simple");
  assert.equal(validateConvention("log"), "log");
});

test("完整案例对齐: 缺测日期被剔除并记录", () => {
  const data = rows([
    ["2024-01-01", "A", 0.01],
    ["2024-01-01", "B", 0.02],
    ["2024-01-02", "A", 0.03],
    // 2024-01-02 缺 B => 整日剔除
  ]);
  const { scenarios, quality } = alignReturns(data, ["A", "B"]);
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].date, "2024-01-01");
  assert.ok(quality.missingCells.includes("2024-01-02|B"));
});

test("重复 (日期,资产) 被拒绝", () => {
  const data = rows([
    ["2024-01-01", "A", 0.01],
    ["2024-01-01", "A", 0.02],
  ]);
  assert.throws(() => alignReturns(data, ["A"]), /重复/);
});

test("非有限收益与非法日期被处理", () => {
  const data = rows([
    ["2024-01-01", "A", 0.01],
    ["2024-01-02", "A", Number.NaN],
  ]);
  const { scenarios, quality } = alignReturns(data, ["A"]);
  assert.equal(scenarios.length, 1);
  assert.ok(quality.nonFiniteCells.includes("2024-01-02|A"));
  assert.throws(
    () => alignReturns(rows([["2024-13-40", "A", 0.01]]), ["A"]),
    /非法日期/
  );
});

