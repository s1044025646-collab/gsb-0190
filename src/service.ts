/** 分析服务：对齐样本、组合损失、尾部归因、情景冲击、缩放对照、自助区间。 */
import { DB, DbError } from "./db";
import { computeRisk, bootstrapCI, assertValidConfidence, assertFiniteAmount, tailMass, RiskError } from "./risk";

export interface AnalysisRequest {
  datasetId: number;
  datasetVersion?: number;
  positionSetId: number;
  positionVersion?: number;
  confidence: number;
  bootstrapSamples?: number;   // 0 表示不计算
  bootstrapSeed?: number;
  scenarioShocks?: Record<string, number>; // 简单收益率冲击，作为额外情景样本
  positionScale?: number;      // 头寸缩放对照
}

export class Service {
  constructor(public db: DB) {}

  runAnalysis(req: AnalysisRequest): { analysisId: number; snapshot: any } {
    assertValidConfidence(req.confidence);
    const scale = req.positionScale ?? 1;
    assertFiniteAmount(scale, "头寸缩放系数");
    if (scale <= 0) throw new RiskError("INVALID_SCALE", "头寸缩放系数必须为正数");
    const bs = req.bootstrapSamples ?? 0;
    if (bs > 0 && (req.bootstrapSeed == null || !Number.isInteger(req.bootstrapSeed))) {
      throw new RiskError("INVALID_BOOTSTRAP", "启用自助抽样时必须提供整数随机种子 bootstrapSeed");
    }

    const dVersion = req.datasetVersion ?? this.db.latestDatasetVersion(req.datasetId);
    const pVersion = req.positionVersion ?? this.db.latestPositionVersion(req.positionSetId);
    const ds = this.db.getDatasetVersion(req.datasetId, dVersion);
    const pos = this.db.getPositionVersion(req.positionSetId, pVersion);

    // 头寸中的资产必须存在于数据集
    const symbols = ds.assets.map((a) => a.symbol);
    for (const sym of pos.holdings.keys()) {
      if (!symbols.includes(sym)) {
        throw new DbError("UNKNOWN_ASSET", `头寸引用了数据集 ${req.datasetId} v${dVersion} 中不存在的资产: ${sym}`);
      }
    }

    // complete-case：剔除任一资产缺测的日期
    const validDates: string[] = [];
    const excludedDates: string[] = [];
    for (const date of ds.dates) {
      const row = ds.returns.get(date)!;
      if (symbols.every((s) => row.has(s))) validDates.push(date);
      else excludedDates.push(date);
    }
    if (validDates.length === 0) {
      throw new RiskError("NO_VALID_SAMPLES", "剔除缺测日期后没有有效样本");
    }

    const amounts = symbols.map((s) => (pos.holdings.get(s) ?? 0) * scale);
    const kinds = ds.assets.map((a) => a.kind);

    // 逐日损失（损失 = -P&L，正为亏损）；现金收益率恒为 0，不产生损失
    const daily: { date: string; loss: number; assetPnl: number[] }[] = [];
    for (const date of validDates) {
      const row = ds.returns.get(date)!;
      const assetPnl = symbols.map((s, i) => (kinds[i] === "cash" ? 0 : amounts[i] * row.get(s)!));
      const pnl = assetPnl.reduce((a, b) => a + b, 0);
      daily.push({ date, loss: -pnl, assetPnl });
    }

    // 情景冲击：作为一条额外样本（用户指定的简单收益率冲击）
    const shocks = req.scenarioShocks ?? null;
    let scenarioLoss: number | null = null;
    if (shocks && Object.keys(shocks).length > 0) {
      for (const [sym, sh] of Object.entries(shocks)) {
        if (!symbols.includes(sym)) throw new DbError("UNKNOWN_ASSET", `情景冲击引用未知资产: ${sym}`);
        assertFiniteAmount(sh, `情景冲击 ${sym}`);
      }
      const assetPnl = symbols.map((s, i) => (kinds[i] === "cash" ? 0 : amounts[i] * (shocks[s] ?? 0)));
      scenarioLoss = -assetPnl.reduce((a, b) => a + b, 0);
      daily.push({ date: "__SCENARIO__", loss: scenarioLoss, assetPnl });
    }

    const losses = daily.map((d) => d.loss);
    const risk = computeRisk(losses, req.confidence);

    // 尾部归因：贡献_i = Σ_tail w_t * (-assetPnl_{i,t}) / m；贡献之和恒等于 ES
    const m = tailMass(risk.n, req.confidence);
    const contributions = symbols.map((symbol, i) => {
      let c = 0;
      for (const t of risk.tail) c += t.weight * -daily[risk.order[t.index]].assetPnl[i];
      return { symbol, kind: kinds[i], amount: amounts[i], contribution: c / m };
    });
    const contribSum = contributions.reduce((a, c) => a + c.contribution, 0);

    // 自助抽样置信区间（固定种子；统计区间，非未来损失保证）
    let ci = null;
    if (bs > 0) ci = bootstrapCI(losses, req.confidence, bs, req.bootstrapSeed!);

    const snapshot = {
      convention: {
        lossSign: "损失为正，盈利为负（loss = -P&L）",
        quantile: "type-7 线性插值经验分位数",
        es: "尾部质量 m=n*(1-c)，最大 floor(m) 个样本权重 1，边界样本分数权重",
        returnType: ds.returnType === "log" ? "log（导入时已转换为 simple）" : "simple",
        missingData: "complete-case：任一资产缺测的日期被剔除",
        note: "组合 VaR 由组合损失分布直接计算，绝不等于各资产 VaR 之和；置信区间为统计区间，不构成未来损失保证",
      },
      dataset: { id: req.datasetId, version: dVersion },
      positionSet: { id: req.positionSetId, version: pVersion },
      confidence: req.confidence,
      positionScale: scale,
      nSamples: risk.n,
      nHistorical: validDates.length,
      excludedDates,
      scenarioShocks: shocks,
      scenarioLoss,
      var: risk.varLoss,
      es: risk.es,
      contributions,
      contributionSum: contribSum,
      sortedLossesAsc: risk.sortedLossesAsc,
      sortedDates: risk.order.map((i) => daily[i].date),
      tailWeights: risk.tail,
      dailyLosses: daily.map((d) => ({ date: d.date, loss: d.loss })),
      bootstrap: ci,
    };

    const analysisId = this.db.createAnalysis({
      datasetId: req.datasetId, datasetVersion: dVersion,
      positionSetId: req.positionSetId, positionVersion: pVersion,
      confidence: req.confidence, bootstrapSamples: bs,
      bootstrapSeed: req.bootstrapSeed ?? null,
      scenarioShocks: shocks, positionScale: scale,
    });
    this.db.saveResult(analysisId, risk.n, risk.varLoss, risk.es, snapshot);
    return { analysisId, snapshot };
  }

  /** 工况比较：同一数据集下多组头寸/配置的 ES、VaR 与贡献对比 */
  compare(analysisIds: number[]): object {
    const items = analysisIds.map((id) => {
      const a = this.db.getAnalysis(id);
      const r = this.db.getResult(id);
      return {
        analysisId: id,
        dataset: { id: a.dataset_id, version: a.dataset_version },
        positionSet: { id: a.position_set_id, version: a.position_version },
        confidence: a.confidence,
        positionScale: a.position_scale,
        scenarioShocks: a.scenario_shocks ? JSON.parse(a.scenario_shocks) : null,
        var: r.var_loss,
        es: r.es,
        contributions: r.result.contributions,
      };
    });
    return { items, note: "各工况 ES 差异源于头寸与情景，不构成未来损失预测" };
  }
}

