/**
 * 领域类型定义。
 *
 * 损失/盈亏符号约定(全项目统一):
 *   pnl  = 正为盈利, 负为亏损
 *   loss = -pnl, 正为亏损, 负为盈利
 * VaR 与 ES 均以“损失为正”报告。
 */

export type ReturnConvention = "simple" | "log";

/** 单个资产的一条对齐后的日观测 */
export interface AssetObservation {
  assetId: string;
  /** 简单收益率或对数收益率, 由数据集 returnConvention 声明 */
  ret: number;
}

/** 一个日期截面上所有资产的收益(已对齐、无缺测) */
export interface Scenario {
  date: string; // ISO yyyy-mm-dd
  returns: Record<string, number>;
}

export type PositionSide = "long" | "short" | "cash";

export interface Position {
  assetId: string;
  side: PositionSide;
  /** 当前头寸金额(名义本金, 非负有限数) */
  notional: number;
}

/** 情景冲击: 对指定资产的日收益率叠加一个冲击(同收益率口径, 加性) */
export interface ScenarioShock {
  assetId: string;
  /** 加性冲击, 例如 -0.10 表示叠加 -10% 的日收益冲击 */
  shock: number;
}

export interface AnalysisConfig {
  /** 置信水平, 取值 (0,1), 例如 0.95 / 0.99 */
  confidence: number;
  /** 可选情景冲击 */
  shocks?: ScenarioShock[];
  /** 头寸统一缩放倍数, 必须为正有限数; 默认 1 */
  scale?: number;
  /** 自助抽样设置 */
  bootstrap?: {
    enabled: boolean;
    /** 重抽样本数 */
    samples: number;
    /** 区间置信水平, 取值 (0,1) */
    ciLevel: number;
    /** 固定随机种子(整数), 保证重现 */
    seed: number;
  };
}

/** 排序后的样本条目 */
export interface RankedLoss {
  date: string;
  loss: number;
  pnl: number;
  /** 按损失降序后的 1 基序号 */
  rank: number;
  /** 在 ES 尾部平均中的权重(分数权重仅落在 VaR 边界点) */
  tailWeight: number;
  /** 该情景下各资产的损失贡献(损失为正) */
  contributions: Record<string, number>;
}

export interface AssetTailSummary {
  assetId: string;
  side: PositionSide;
  notional: number;
  /** 该资产对组合 ES 的平均尾部贡献 */
  esContribution: number;
  /** 占组合 ES 的比例(全盈利时为 0) */
  share: number;
}

export interface BootstrapResult {
  enabled: boolean;
  method: "nonparametric-empirical-resampling";
  samples: number;
  sampleSize: number;
  seed: number;
  ciLevel: number;
  /** VaR 自助抽样分位数区间(损失为正) */
  varCi: [number, number];
  /** ES 自助抽样分位数区间(损失为正) */
  esCi: [number, number];
}

export interface RiskResult {
  datasetId: string;
  datasetVersion: number;
  positionSetId: string;
  positionVersion: number;
  returnConvention: ReturnConvention;
  confidence: number;
  quantileConvention: string;
  esConvention: string;
  scale: number;
  effectiveScenarios: number;
  validSamples: number;
  allProfitable: boolean;
  /** 尾部期望超出量对应的尾部概率(可能不能整除样本数) */
  tailProbability: number;
  varLoss: number;
  esLoss: number;
  rankedLosses: RankedLoss[];
  assetContributions: AssetTailSummary[];
  bootstrap?: BootstrapResult;
  shocks: ScenarioShock[];
}
