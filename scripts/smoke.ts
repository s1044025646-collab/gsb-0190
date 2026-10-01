import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 8799;
const dir = mkdtempSync(join(tmpdir(), "ptrisk-smoke-"));
const srv = spawn(process.execPath, [join(process.cwd(), "dist", "src", "http", "server.js")], {
  env: { ...process.env, PORT: String(port), PTRISK_DATA_DIR: dir },
  stdio: "ignore",
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main(): Promise<void> {
  await sleep(800);
  const health = await req("GET", "/health");
  if (!health.ok) throw new Error("health failed");

  await req("POST", "/datasets", {
    id: "s",
    returnConvention: "simple",
    assets: ["A"],
    rows: [
      { date: "2024-01-01", assetId: "A", ret: -0.1 },
      { date: "2024-01-02", assetId: "A", ret: 0.05 },
      { date: "2024-01-03", assetId: "A", ret: -0.2 },
    ],
  });
  await req("POST", "/positions", {
    id: "sp",
    positions: [{ assetId: "A", side: "long", notional: 1000 }],
  });
  const a = await req("POST", "/analyses", {
    datasetId: "s",
    positionSetId: "sp",
    config: { confidence: 0.9 },
  });
  const daily = await req("GET", `/analyses/${a.analysisId}/daily-losses`);
  if (daily[0].loss !== 200) throw new Error(`expected worst loss 200, got ${daily[0].loss}`);

  // 错误处理: 越界置信水平
  const bad = await fetch(`http://localhost:${port}/analyses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      datasetId: "s",
      positionSetId: "sp",
      config: { confidence: 1.5 },
    }),
  });
  if (bad.status !== 400) throw new Error("expected 400 for invalid confidence");
  console.log("HTTP 冒烟测试通过");
}

main()
  .then(() => {
    srv.kill();
    setTimeout(() => process.exit(0), 100);
  })
  .catch((e) => {
    console.error(e);
    srv.kill();
    setTimeout(() => process.exit(1), 100);
  });
