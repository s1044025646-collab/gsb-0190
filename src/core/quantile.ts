/**
 * 经验分位数与排序工具。
 *
 * 分位数约定: 采用 R 语言 type-7 约定(与 numpy linear / Excel PERCENTILE.INC 同族):
 *   对升序样本 x_(1) <= ... <= x_(n), 概率 p 对应位置 h = (n-1)*p,
 *   令 k = floor(h), g = h - k, 则
 *     Q(p) = x_(k+1) + g * (x_(k+2) - x_(k+1))   (索引按 0 基处理)
 *   边界 p=0 取最小值, p=1 取最大值。
 *
 * 该约定在 h 为整数时天然处理“分位点重复”, 在非整数时对相邻两值线性插值,
 * 因此“尾部概率不能整除样本数”时仍有唯一确定结果。
 */

export function quantileType7(sortedAscending: number[], p: number): number {
  const n = sortedAscending.length;
  if (n === 0) throw new Error("分位数计算需要至少 1 个样本");
  if (!(p >= 0 && p <= 1)) throw new Error(`分位数概率越界: ${p}`);
  if (n === 1) return sortedAscending[0];
  const h = (n - 1) * p;
  const k = Math.floor(h);
  const g = h - k;
  const lo = sortedAscending[k];
  const hi = sortedAscending[Math.min(k + 1, n - 1)];
  return lo + g * (hi - lo);
}

/** 排序比较器(数值) */
export function ascending(a: number, b: number): number {
  return a - b;
}
