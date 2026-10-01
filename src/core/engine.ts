import {
  AnalysisConfig,
  AssetTailSummary,
  BootstrapResult,
  Position,
  RankedLoss,
  ReturnConvention,
  RiskResult,
  Scenario,
  ScenarioShock,
} from "./types.js";
import { quantileType7 } from "./quantile.js";
import { mulberry32, resampleIndices } from "./rng.js";

interface InternalMeta {
  datasetId: string;
  datasetVersion: number;
  positionSetId: string;
  positionVersion: number;
  returnConvention: ReturnConvention;
}

interface ScenarioPnl {
  date: string;
  pnl: number;
  contributions: Record<string, number>;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function validateConfig(confidence: number, scale: number): void {
  if (!isFiniteNumber(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error(`置信水平必须严格位于 (0,1), 收到 ${confidence}`);
  }
  if (!isFiniteNumber(scale) || scale <= 0) {
    throw new Error(`头寸缩放倍数必须为正的有限数, 收到 ${scale}`);
  }
}

function validatePositions(positions: Position[]): void {
  if (positions.length === 0) throw new Error("头寸列表为空, 至少需要现金或一个资产头寸");
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p.assetId)) throw new Error(`资产头寸重复: ${p.assetId}`);
    seen.add(p.assetId);
    if (!["long", "short", "cash"].includes(p.side)) {
      throw new Error(`头寸方向非法: ${p.assetId} -> ${p.side}`);
    }
    if (!isFiniteNumber(p.notional) || p.notional < 0) {
      throw new Error(`头寸金额必须为非负有限数: ${p.assetId} -> ${p.notional}`);
    }
  }
}

function appliedShocks(scenarios: Scenario[], shocks: ScenarioShock[]): Scenario[] {
  if (shocks.length === 0) return scenarios;
  return scenarios.map((s) => {
    const returns = { ...s.returns };
    for (const sh of shocks) {
      if (!(sh.assetId in returns)) {
        throw new Error(`冲击所指资产不在对齐数据集中: ${sh.assetId}`);
      }
      if (!isFiniteNumber(sh.shock)) throw new Error(`冲击值非有限数: ${sh.assetId}`);
      returns[sh.assetId] = returns[sh.assetId] + sh.shock;
    }
    return { date: s.date, returns };
  });
}

/**
 * 逐情景盈亏与每资产损失贡献。
 * 简单收益与对数收益在单日尺度下, 头寸金额损益均按 notional * ret 计算
 * (对数收益仅在单日且作为教学口径时采用该一阶近似; 混算在数据导入阶段即被禁止)。
 * 多头: pnl = +notional*ret; 空头: pnl = -notional*ret; 现金: 0。
 * 每资产损失贡献 = -该资产 pnl。
 */
function buildScenarioPnl(scenarios: Scenario[], positions: Position[]): ScenarioPnl[] {
  return scenarios.map((s) => {
    const contributions: Record<string, number> = {};
    let totalPnl = 0;
    for (const p of positions) {
      let assetPnl = 0;
      if (p.side === "cash") {
        assetPnl = 0;
      } else {
        const ret = s.returns[p.assetId];
        if (!isFiniteNumber(ret)) {
          throw new Error(`情景 ${s.date} 缺少资产 ${p.assetId} 的对齐收益`);
        }
        assetPnl = (p.side === "long" ? 1 : -1) * p.notional * ret;
      }
      totalPnl += assetPnl;
      contributions[p.assetId] = -assetPnl; // 损失为正
    }
    return { date: s.date, pnl: totalPnl, contributions };
  });
}

interface TailComputation {
  varLoss: number;
  esLoss: number;
  tailProbability: number;
  ranked: RankedLoss[];
  allProfitable: boolean;
}

/**
 * 计算 VaR / ES 并给排序样本赋予尾部权重。
 *
 * VaR: 以损失 L = -pnl 计, VaR_c = Q_p(L), p = 1 - c, 分位数约定 R-7。
 * ES(条件期望尾部损失): 对“损失 >= VaR”的情景做加权平均, 其中恰好在 VaR
 * 边界上的情景只计入使其尾部总质量恰等于 p 所需的分数权重。
 * 这样在尾部概率不能整除样本数时仍保证 ES 定义一致, 且权重和 = ceil(n*p)
 * 与“严格在尾部内”的整数个数之间保持正确的分数补足。
 */
function computeTail(rows: ScenarioPnl[], confidence: number): TailComputation {
  const n = rows.length;
  const tailProb = 1 - confidence;
  const m = n * tailProb;
  const k = Math.floor(m);
  const g = m - k;

  // 按损失降序; 损失相同按日期升序, 保证并列时确定性
  const withLoss = rows.map((r) => ({ r, loss: -r.pnl }));
  withLoss.sort(
    (a, b) => b.loss - a.loss || (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : 0)
  );
  const sorted = withLoss.map((x) => x.r);
  const lossesDesc = withLoss.map((x) => x.loss);
  const lossesAsc = [...lossesDesc].sort((a, b) => a - b);
  // VaR 是损失分布的高尾分位数 Q_c(L)(损失为正)
  const varLoss = quantileType7(lossesAsc, confidence);

  const allProfitable = lossesDesc[0] <= 0;

  const ranked: RankedLoss[] = sorted.map((r, i) => {
    let tailWeight = 0;
    if (i < k) tailWeight = 1;
    else if (i === k && g > 0) tailWeight = g;
    return {
      date: r.date,
      loss: -r.pnl,
      pnl: r.pnl,
      rank: i + 1,
      tailWeight,
      contributions: r.contributions,
    };
  });

  let weightSum = 0;
  let weightedLoss = 0;
  for (const r of ranked) {
    weightSum += r.tailWeight;
    weightedLoss += r.tailWeight * r.loss;
  }
  // weightSum 数值上恒等于 m = n*(1-c); m=0 时(极端 c 接近 1)回退为 0
  const esLoss = weightSum > 1e-12 ? weightedLoss / weightSum : 0;

  return {
    varLoss,
    esLoss,
    tailProbability: tailProb,
    ranked,
    allProfitable,
  };
}

function summarizeAssets(
  ranked: RankedLoss[],
  positions: Position[],
  esLoss: number
): AssetTailSummary[] {
  let weightSum = 0;
  const acc: Record<string, number> = {};
  for (const p of positions) acc[p.assetId] = 0;
  for (const r of ranked) {
    weightSum += r.tailWeight;
    for (const key of Object.keys(r.contributions)) {
      acc[key] = (acc[key] ?? 0) + r.tailWeight * r.contributions[key];
    }
  }
  return positions.map((p) => {
    const esContribution = weightSum > 1e-12 ? acc[p.assetId] / weightSum : 0;
    return {
      assetId: p.assetId,
      side: p.side,
      notional: p.notional,
      esContribution,
      share: esLoss > 1e-12 || esLoss < -1e-12 ? esContribution / esLoss : 0,
    };
  });
}

function runBootstrap(
  rows: ScenarioPnl[],
  confidence: number,
  bs: NonNullable<AnalysisConfig["bootstrap"]>
): BootstrapResult {
  if (!Number.isInteger(bs.samples) || bs.samples <= 0) {
    throw new Error(`自助抽样 samples 必须为正整数, 收到 ${bs.samples}`);
  }
  if (!isFiniteNumber(bs.ciLevel) || bs.ciLevel <= 0 || bs.ciLevel >= 1) {
    throw new Error(`自助区间置信水平必须位于 (0,1), 收到 ${bs.ciLevel}`);
  }
  if (!Number.isInteger(bs.seed)) throw new Error(`随机种子必须为整数, 收到 ${bs.seed}`);

  const rand = mulberry32(bs.seed);
  const n = rows.length;
  const vars: number[] = [];
  const ess: number[] = [];
  for (let s = 0; s < bs.samples; s++) {
    const idx = resampleIndices(rand, n, n);
    const resampled = idx.map((i) => rows[i]);
    const t = computeTail(resampled, confidence);
    vars.push(t.varLoss);
    ess.push(t.esLoss);
  }
  vars.sort((a, b) => a - b);
  ess.sort((a, b) => a - b);
  const a = (1 - bs.ciLevel) / 2;
  return {
    enabled: true,
    method: "nonparametric-empirical-resampling",
    samples: bs.samples,
    sampleSize: n,
    seed: bs.seed,
    ciLevel: bs.ciLevel,
    varCi: [quantileType7(vars, a), quantileType7(vars, 1 - a)],
    esCi: [quantileType7(ess, a), quantileType7(ess, 1 - a)],
  };
}

export interface ComputeInput {
  scenarios: Scenario[];
  positions: Position[];
  config: AnalysisConfig;
  meta: InternalMeta;
}

export function computeRisk(input: ComputeInput): RiskResult {
  const { scenarios, positions, config, meta } = input;
  const scale = config.scale ?? 1;
  const shocks = config.shocks ?? [];
  validateConfig(config.confidence, scale);
  validatePositions(positions);
  if (scenarios.length === 0) throw new Error("无有效样本: 对齐后的情景数为 0");

  const shocked = appliedShocks(scenarios, shocks);
  const scaledPositions: Position[] = positions.map((p) => ({
    ...p,
    notional: p.notional * scale,
  }));
  const rows = buildScenarioPnl(shocked, scaledPositions);
  const tail = computeTail(rows, config.confidence);
  const assetContributions = summarizeAssets(tail.ranked, scaledPositions, tail.esLoss);

  const result: RiskResult = {
    datasetId: meta.datasetId,
    datasetVersion: meta.datasetVersion,
    positionSetId: meta.positionSetId,
    positionVersion: meta.positionVersion,
    returnConvention: meta.returnConvention,
    confidence: config.confidence,
    quantileConvention:
      "VaR = 损失分布高尾经验分位数 Q_c(L), R type-7 (h=(n-1)c 线性插值), 损失为正",
    esConvention:
      "ES = 最大损失排序后前 floor(n(1-c)) 个全权重 + 次一名分数权重 g=n(1-c)-floor(...) 的加权平均",
    scale,
    effectiveScenarios: scenarios.length,
    validSamples: scenarios.length,
    allProfitable: tail.allProfitable,
    tailProbability: tail.tailProbability,
    varLoss: tail.varLoss,
    esLoss: tail.esLoss,
    rankedLosses: tail.ranked,
    assetContributions,
    shocks,
  };

  if (config.bootstrap?.enabled) {
    result.bootstrap = runBootstrap(rows, config.confidence, config.bootstrap);
  }
  return result;
}
