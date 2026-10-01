/**
 * 可固定种子的确定性伪随机数生成器(mulberry32)。
 * 仅用于自助抽样等教学用途, 不用于加密。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从 0..n-1 中有放回抽取 size 个索引 */
export function resampleIndices(rand: () => number, n: number, size: number): number[] {
  const idx: number[] = new Array(size);
  for (let i = 0; i < size; i++) {
    idx[i] = Math.floor(rand() * n);
  }
  return idx;
}
