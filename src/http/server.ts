import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Store } from "../db/store.js";
import { RiskService } from "../services/service.js";
import { Position } from "../core/types.js";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.PTRISK_DATA_DIR
  ? resolve(process.env.PTRISK_DATA_DIR)
  : resolve(process.cwd(), "data");
const DB_PATH = resolve(DATA_DIR, "ptrisk.sqlite");

const store = new Store(DB_PATH);
const service = new RiskService(store);

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  res.writeHead(status, { "Content-Type": `${contentType}; charset=utf-8` });
  res.end(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function normalizePositions(raw: any): Position[] {
  if (!Array.isArray(raw?.positions)) throw new Error("请求体需要 positions 数组");
  return raw.positions.map((p: any) => ({
    assetId: String(p.assetId),
    side: String(p.side) as Position["side"],
    notional: Number(p.notional),
  }));
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, db: DB_PATH });
    }

    if (method === "GET" && path === "/datasets") {
      return send(res, 200, service.listDatasets());
    }
    if (method === "GET" && path === "/positions") {
      return send(res, 200, service.listPositionSets());
    }
    if (method === "GET" && path === "/analyses") {
      return send(res, 200, service.listAnalyses());
    }

    if (method === "POST" && path === "/datasets") {
      const body = await readJson(req);
      const out = await service.importDataset({
        id: String(body.id),
        returnConvention: body.returnConvention,
        assets: body.assets,
        rows: body.rows,
        note: body.note,
      });
      return send(res, 201, out);
    }

    if (method === "POST" && path === "/positions") {
      const body = await readJson(req);
      const out = await service.savePositions(
        String(body.id),
        normalizePositions(body),
        body.note ?? ""
      );
      return send(res, 201, out);
    }

    if (method === "POST" && path === "/analyses") {
      const body = await readJson(req);
      const out = await service.runAnalysis({
        datasetId: String(body.datasetId),
        datasetVersion: body.datasetVersion,
        positionSetId: String(body.positionSetId),
        positionVersion: body.positionVersion,
        config: body.config,
      });
      return send(res, 201, out);
    }

    const analysisMatch = path.match(/^\/analyses\/([^/]+)(?:\/(daily-losses|tail-contributions|export))?$/);
    if (method === "GET" && analysisMatch) {
      const [, id, sub] = analysisMatch;
      if (sub === "daily-losses") return send(res, 200, service.dailyLosses(id));
      if (sub === "tail-contributions") return send(res, 200, service.tailContributions(id));
      if (sub === "export") {
        const fmt = url.searchParams.get("format") ?? "json";
        if (fmt === "csv-daily") return send(res, 200, service.dailyLossCsv(id), "text/csv");
        if (fmt === "csv-contrib") return send(res, 200, service.contributionCsv(id), "text/csv");
        if (fmt === "csv-summary") return send(res, 200, service.summaryCsv(id), "text/csv");
        return send(res, 200, service.exportJson(id));
      }
      return send(res, 200, service.getResult(id));
    }

    return send(res, 404, { error: `未找到路由: ${method} ${path}` });
  } catch (e) {
    return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

const server = createServer((req, res) => {
  handler(req, res).catch((e) => send(res, 500, { error: String(e) }));
});

server.listen(PORT, () => {
  console.log(`[ptrisk] HTTP API 监听 http://localhost:${PORT}`);
  console.log(`[ptrisk] 数据目录 ${DATA_DIR}`);
});

export { server, service };
