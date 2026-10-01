/** JSON/CSV 导出 */
export function toCsv(snapshot: any): string {
  const lines: string[] = [];
  lines.push("section,key,value");
  lines.push(`summary,confidence,${snapshot.confidence}`);
  lines.push(`summary,n_samples,${snapshot.nSamples}`);
  lines.push(`summary,var_loss,${snapshot.var}`);
  lines.push(`summary,es,${snapshot.es}`);
  if (snapshot.scenarioLoss != null) lines.push(`summary,scenario_loss,${snapshot.scenarioLoss}`);
  if (snapshot.bootstrap) {
    lines.push(`summary,bootstrap_samples,${snapshot.bootstrap.samples}`);
    lines.push(`summary,bootstrap_seed,${snapshot.bootstrap.seed}`);
    lines.push(`summary,var_ci,"[${snapshot.bootstrap.varCI[0]}, ${snapshot.bootstrap.varCI[1]}]"`);
    lines.push(`summary,es_ci,"[${snapshot.bootstrap.esCI[0]}, ${snapshot.bootstrap.esCI[1]}]"`);
  }
  lines.push("");
  lines.push("contribution_symbol,kind,amount,contribution");
  for (const c of snapshot.contributions) lines.push(`${c.symbol},${c.kind},${c.amount},${c.contribution}`);
  lines.push("");
  lines.push("date,loss");
  for (const d of snapshot.dailyLosses) lines.push(`${d.date},${d.loss}`);
  return lines.join("\n");
}
