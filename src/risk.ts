/**
 * 核心风险计算（纯函数模块）。
 *
 * 约定：
 * - 损失(loss) = -P&L，正数表示亏损，负数表示盈利。
 * - 收益率统一使用简单收益率(simple return)。对数收益率在导入时通过 exp(r)-1 转换，
 *   禁止不做转换混算两种收益率。
 * - 分位数约定：经验分位数采用 "type 7"（与 numpy/R 默认一致）的线性插值：
 *   对升序样本 x[0..n-1]，h = (n-1)*q，q 分位数 = x[floor(h)] + (h-floor(h))*(x[floor(h)+1]-x[floor(h)])。
 * - ES（Expected Shortfall，期望尾部损失）：尾部概率 p = 1 - c，尾部期望质量 m = n*p。
 *   取最大的 floor(m) 个损失各赋权重 1，第 floor(m)+1 大损失赋分数权重 m - floor(m)，
 *   ES = (Σ w_i * L_i) / m。这样可处理：
 *   (a) 尾部概率不能整除样本数（分数权重）；
 *   (b) 分位点重复（相同值按权重自然处理，不依赖 VaR 阈值比较）；
 *   (c) 全盈利样本（损失全为负，VaR/ES 为负，公式依然成立）。
 */
export interface TailWeight {
  index: number; // 在升序排序数组中的下标
  weight: number; // (0, 1]
}

export interface RiskResult {
  n: number;
  confidence: number;
  varLoss: number; // VaR，以损失为正
  es: number; // ES，以损失为正
  sortedLossesAsc: number[]; // 升序排序后的损失样本
  order: number[]; // order[k] = 升序第 k 个样本在原始数组中的下标（重复值按稳定排序）
  tail: TailWeight[]; // 尾部权重（升序下标）
}

export class RiskError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "RiskError";
  }
}

export function assertValidConfidence(c: number): void {
  if (!Number.isFinite(c) || c <= 0 || c >= 1) {
    throw new RiskError("INVALID_CONFIDENCE", `置信水平必须位于 (0,1) 开区间，收到: ${c}`);
  }
}

export function assertFiniteAmount(x: number, what: string): void {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new RiskError("NON_FINITE_AMOUNT", `${what} 必须是有限数值，收到: ${x}`);
  }
}

/** type-7 经验分位数（升序数组） */
export function quantileType7(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) throw new RiskError("EMPTY_SAMPLE", "分位数计算需要至少 1 个样本");
  if (n === 1) return sortedAsc[0];
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sortedAsc[lo] + (h - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

/** 尾部质量 m = n*(1-c)，对浮点噪声做 1e-12 级舍入 */
export function tailMass(n: number, confidence: number): number {
  return Math.round(n * (1 - confidence) * 1e12) / 1e12;
}

/** 计算尾部权重：尾部质量 m = n*(1-c)，最大 floor(m) 个权重为 1，边界样本取分数权重 */
export function tailWeights(n: number, confidence: number): TailWeight[] {
  const m = tailMass(n, confidence);
  const full = Math.floor(m);
  const frac = m - full;
  const weights: TailWeight[] = [];
  for (let k = 0; k < full; k++) {
    weights.push({ index: n - 1 - k, weight: 1 });
  }
  if (frac > 1e-12) {
    weights.push({ index: n - 1 - full, weight: frac });
  }
  if (weights.length === 0) {
    // 置信水平极高导致 m<1 且 frac 极小：退化为取最大损失
    weights.push({ index: n - 1, weight: Math.max(m, 1e-12) });
  }
  return weights.sort((a, b) => a.index - b.index);
}

/** 对一组损失样本计算 VaR / ES */
export function computeRisk(losses: number[], confidence: number): RiskResult {
  assertValidConfidence(confidence);
  if (!losses || losses.length === 0) {
    throw new RiskError("NO_VALID_SAMPLES", "没有有效损失样本，无法计算风险");
  }
  for (const l of losses) {
    if (!Number.isFinite(l)) throw new RiskError("NON_FINITE_SAMPLE", `损失样本含非有限值: ${l}`);
  }
  const order = losses.map((_, i) => i).sort((a, b) => losses[a] - losses[b] || a - b);
  const sorted = order.map((i) => losses[i]);
  const n = sorted.length;
  const varLoss = quantileType7(sorted, confidence);
  const tail = tailWeights(n, confidence);
  const m = tailMass(n, confidence);
  let es = 0;
  for (const t of tail) es += t.weight * sorted[t.index];
  es /= m;
  return { n, confidence, varLoss, es, sortedLossesAsc: sorted, order, tail };
}

/** 简单收益率 -> 组合日 P&L（金额）。amount 为头寸金额，空头为负。 */
export function portfolioPnl(amounts: number[], simpleReturns: number[]): number {
  let pnl = 0;
  for (let i = 0; i < amounts.length; i++) pnl += amounts[i] * simpleReturns[i];
  return pnl;
}

/** 对数收益率转简单收益率 */
export function logToSimple(r: number): number {
  return Math.exp(r) - 1;
}

/** 固定种子 PRNG（mulberry32），保证自助抽样可重现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI {
  method: string;
  samples: number;
  seed: number;
  varCI: [number, number];
  esCI: [number, number];
  level: number; // 区间覆盖率，如 0.9
}

/** 固定种子自助抽样置信区间（percentile 法）。统计区间，不是未来损失保证。 */
export function bootstrapCI(
  losses: number[],
  confidence: number,
  resamples: number,
  seed: number,
  ciLevel = 0.9
): BootstrapCI {
  if (losses.length === 0) throw new RiskError("NO_VALID_SAMPLES", "自助抽样需要至少 1 个样本");
  if (!Number.isInteger(resamples) || resamples < 100) {
    throw new RiskError("INVALID_BOOTSTRAP", "自助抽样次数必须是 >=100 的整数");
  }
  const rand = mulberry32(seed);
  const vars: number[] = [];
  const ess: number[] = [];
  const n = losses.length;
  for (let b = 0; b < resamples; b++) {
    const sample: number[] = new Array(n);
    for (let i = 0; i < n; i++) sample[i] = losses[Math.floor(rand() * n)];
    const r = computeRisk(sample, confidence);
    vars.push(r.varLoss);
    ess.push(r.es);
  }
  vars.sort((a, b) => a - b);
  ess.sort((a, b) => a - b);
  const alpha = (1 - ciLevel) / 2;
  return {
    method: "percentile-bootstrap-iid",
    samples: resamples,
    seed,
    level: ciLevel,
    varCI: [quantileType7(vars, alpha), quantileType7(vars, 1 - alpha)],
    esCI: [quantileType7(ess, alpha), quantileType7(ess, 1 - alpha)],
  };
}
