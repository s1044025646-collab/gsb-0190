/** HTTP API（node:http，无外部依赖）。PORT 环境变量可配置端口，默认 8190。 */
import * as http from "node:http";
import { DB, DbError } from "./db";
import { Service, AnalysisRequest } from "./service";
import { RiskError } from "./risk";
import { toCsv } from "./export";

export function createServer(dbFile: string): http.Server {
  const db = new DB(dbFile);
  const svc = new Service(db);

  const send = (res: http.ServerResponse, code: number, body: unknown, csv = false) => {
    res.writeHead(code, { "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8" });
    res.end(csv ? (body as string) : JSON.stringify(body, null, 2));
  };
  const fail = (res: http.ServerResponse, e: any) => {
    if (e instanceof RiskError || e instanceof DbError) {
      send(res, 400, { error: { code: e.code, message: e.message } });
    } else {
      send(res, 500, { error: { code: "INTERNAL", message: String(e?.message ?? e) } });
    }
  };
  const readBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new DbError("BAD_JSON", "请求体不是合法 JSON")); } });
      req.on("error", reject);
    });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /datasets {name}
      if (req.method === "POST" && url.pathname === "/datasets") {
        const b = await readBody(req);
        return send(res, 201, { datasetId: db.createDataset(b.name ?? "dataset") });
      }
      // POST /datasets/:id/returns {returnType, assets, rows, note}
      let mm = url.pathname.match(/^\/datasets\/(\d+)\/returns$/);
      if (req.method === "POST" && mm) {
        const b = await readBody(req);
        const version = db.importReturns(Number(mm[1]), b.returnType, b.assets, b.rows, b.note ?? "");
        return send(res, 201, { version });
      }
      // GET /datasets/:id/quality?version=
      mm = url.pathname.match(/^\/datasets\/(\d+)\/quality$/);
      if (req.method === "GET" && mm) {
        const id = Number(mm[1]);
        const v = url.searchParams.get("version");
        const version = v ? Number(v) : db.latestDatasetVersion(id);
        return send(res, 200, db.qualityCheck(id, version));
      }
      // POST /position-sets {name}
      if (req.method === "POST" && url.pathname === "/position-sets") {
        const b = await readBody(req);
        return send(res, 201, { positionSetId: db.createPositionSet(b.name ?? "positions") });
      }
      // POST /position-sets/:id/positions {holdings, note}
      mm = url.pathname.match(/^\/position-sets\/(\d+)\/positions$/);
      if (req.method === "POST" && mm) {
        const b = await readBody(req);
        return send(res, 201, { version: db.commitPositions(Number(mm[1]), b.holdings, b.note ?? "") });
      }
      // POST /analyses  AnalysisRequest
      if (req.method === "POST" && url.pathname === "/analyses") {
        const b = (await readBody(req)) as AnalysisRequest;
        const out = svc.runAnalysis(b);
        return send(res, 201, { analysisId: out.analysisId, result: out.snapshot });
      }
      // GET /analyses
      if (req.method === "GET" && url.pathname === "/analyses") {
        return send(res, 200, db.listAnalyses());
      }
      // GET /analyses/:id (完整快照) /daily-losses /tail-contributions /export?format=
      mm = url.pathname.match(/^\/analyses\/(\d+)(?:\/(daily-losses|tail-contributions|export))?$/);
      if (req.method === "GET" && mm) {
        const id = Number(mm[1]);
        const sub = mm[2];
        const r = db.getResult(id).result;
        if (!sub) return send(res, 200, r);
        if (sub === "daily-losses") return send(res, 200, r.dailyLosses);
        if (sub === "tail-contributions") {
          return send(res, 200, { contributions: r.contributions, tailWeights: r.tailWeights, sortedDates: r.sortedDates });
        }
        const format = url.searchParams.get("format") ?? "json";
        if (format === "csv") return send(res, 200, toCsv(r), true);
        return send(res, 200, r);
      }
      // POST /compare {analysisIds: []}
      if (req.method === "POST" && url.pathname === "/compare") {
        const b = await readBody(req);
        return send(res, 200, svc.compare(b.analysisIds));
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: `${req.method} ${url.pathname}` } });
    } catch (e) {
      fail(res, e);
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8190);
  const dbFile = process.env.RISK_DB ?? "data/risk.db";
  createServer(dbFile).listen(port, () => {
    console.log(`风险服务已启动: http://localhost:${port} (数据库: ${dbFile})`);
  });
}
