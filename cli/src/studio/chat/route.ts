// Pathname dispatch for /api/studio/chat/*.
//
// Returns true when the request matched and was handled, false when
// nothing on this prefix applied — letting server.ts continue its
// pathname chain (404 fall-through).

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ChatService } from "./runner.js";
import { isValidThreadId } from "./store.js";
import { isSupportedAgentId } from "./adapters/index.js";
import { SseSink } from "./sse.js";
import type { AgentId, JsonlLine } from "./types.js";

export interface ChatRouteContext {
  getService: (workspaceId?: string | null) => ChatService | ChatRouteServiceError;
  findRunService: (runId: string) => ChatService | null;
}

export interface ChatRouteServiceError {
  status: number;
  payload: { error: string; message: string; details?: unknown };
}

export interface ChatRouteHelpers {
  readBody: (req: IncomingMessage, limitBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void;
}

export interface ChatRouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  method: string;
}

const PROMPT_BYTE_CAP = 64 * 1024;

const THREAD_ROOT = "/api/studio/chat/threads";
const RUN_ROOT = "/api/studio/chat/runs";

export async function handleChatRoute(
  ctx: ChatRouteContext,
  helpers: ChatRouteHelpers,
  reqInfo: ChatRouteRequest
): Promise<boolean> {
  const { res, pathname, method } = reqInfo;

  if (!pathname.startsWith("/api/studio/chat/")) return false;

  // ---- POST /threads ----
  if (pathname === THREAD_ROOT && method === "POST") {
    const body = (await helpers.readBody(reqInfo.req)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      helpers.sendJson(res, 400, { error: "invalid_body", message: "expected JSON object" });
      return true;
    }
    const agentId = String(body.agentId ?? "");
    const model = String(body.model ?? "default");
    const title = typeof body.title === "string" ? body.title : undefined;
    if (!isSupportedAgentId(agentId)) {
      helpers.sendJson(res, 400, {
        error: "agent_unsupported",
        message: "Studio v1 supports claude-code and codex only"
      });
      return true;
    }
    const serviceResult = ctx.getService(workspaceFromBody(body));
    if (isServiceError(serviceResult)) {
      helpers.sendJson(res, serviceResult.status, serviceResult.payload);
      return true;
    }
    const service = serviceResult;
    await service.getStore().hydrate();
    const meta = await service.getStore().createThread({
      agentId: agentId as AgentId,
      model,
      title
    });
    helpers.sendJson(res, 201, {
      schema_version: "studio-chat-thread.v1",
      thread: toSummary(meta)
    });
    return true;
  }

  // ---- GET /threads ----
  if (pathname === THREAD_ROOT && (method === "GET" || method === "HEAD")) {
    const serviceResult = ctx.getService(workspaceFromQuery(reqInfo));
    if (isServiceError(serviceResult)) {
      helpers.sendJson(res, serviceResult.status, serviceResult.payload);
      return true;
    }
    const service = serviceResult;
    await service.getStore().hydrate();
    helpers.sendJson(res, 200, {
      schema_version: "studio-chat-threads.v1",
      threads: service.getStore().listThreads()
    });
    return true;
  }

  // ---- /threads/:id ----
  const threadIdMatch = /^\/api\/studio\/chat\/threads\/([^/]+)$/.exec(pathname);
  if (threadIdMatch) {
    const id = threadIdMatch[1] as string;
    if (!isValidThreadId(id)) {
      helpers.sendJson(res, 400, { error: "invalid_thread", message: "thread id is malformed" });
      return true;
    }
    const serviceResult = ctx.getService(workspaceFromQuery(reqInfo));
    if (isServiceError(serviceResult)) {
      helpers.sendJson(res, serviceResult.status, serviceResult.payload);
      return true;
    }
    const service = serviceResult;
    if (method === "GET" || method === "HEAD") {
      await service.getStore().hydrate();
      const meta = service.getStore().getThread(id);
      if (!meta) {
        helpers.sendJson(res, 404, { error: "thread_not_found", message: id });
        return true;
      }
      const messages: JsonlLine[] = await service.getStore().readMessages(id);
      helpers.sendJson(res, 200, {
        schema_version: "studio-chat-thread-detail.v1",
        thread: toSummary(meta),
        messages
      });
      return true;
    }
    if (method === "DELETE") {
      service.abortByThread(id);
      await service.getStore().deleteThread(id);
      res.writeHead(204);
      res.end();
      return true;
    }
    res.writeHead(405, { allow: "GET, DELETE" });
    res.end();
    return true;
  }

  // ---- POST /threads/:id/runs ----
  const postRunMatch = /^\/api\/studio\/chat\/threads\/([^/]+)\/runs$/.exec(pathname);
  if (postRunMatch && method === "POST") {
    const id = postRunMatch[1] as string;
    if (!isValidThreadId(id)) {
      helpers.sendJson(res, 400, { error: "invalid_thread", message: "thread id is malformed" });
      return true;
    }
    let body: Record<string, unknown> | null;
    try {
      body = (await helpers.readBody(reqInfo.req, PROMPT_BYTE_CAP)) as Record<string, unknown>;
    } catch (err) {
      helpers.sendJson(res, 413, {
        error: "prompt_too_large",
        message: (err as Error).message
      });
      return true;
    }
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    if (prompt.trim().length === 0) {
      helpers.sendJson(res, 400, { error: "missing_prompt", message: "prompt is required" });
      return true;
    }
    const modelOverride = typeof body?.modelOverride === "string" ? body.modelOverride : undefined;
    const serviceResult = ctx.getService(workspaceFromBody(body));
    if (isServiceError(serviceResult)) {
      helpers.sendJson(res, serviceResult.status, serviceResult.payload);
      return true;
    }
    const service = serviceResult;
    await service.getStore().hydrate();
    const result = await service.postRun({ threadId: id, prompt, modelOverride });
    if (result.kind === "error") {
      helpers.sendJson(res, result.status, result.body);
      return true;
    }
    helpers.sendJson(res, 202, {
      schema_version: "studio-chat-run.v1",
      runId: result.outcome.runId,
      streamUrl: result.outcome.streamUrl
    });
    return true;
  }

  // ---- GET /runs/:runId/stream ----
  const streamMatch = /^\/api\/studio\/chat\/runs\/([^/]+)\/stream$/.exec(pathname);
  if (streamMatch && (method === "GET" || method === "HEAD")) {
    const runId = streamMatch[1] as string;
    const service = ctx.findRunService(runId);
    if (!service) {
      helpers.sendJson(res, 404, { error: "run_not_found", message: runId });
      return true;
    }
    const run = service.getRun(runId);
    if (!run) {
      helpers.sendJson(res, 404, { error: "run_not_found", message: runId });
      return true;
    }
    const sink = new SseSink(res);
    if (method === "HEAD") {
      sink.close();
      return true;
    }
    service.attachSink(runId, sink);
    return true;
  }

  // ---- POST /runs/:runId/abort ----
  const abortMatch = /^\/api\/studio\/chat\/runs\/([^/]+)\/abort$/.exec(pathname);
  if (abortMatch && method === "POST") {
    const runId = abortMatch[1] as string;
    const service = ctx.findRunService(runId);
    if (!service) {
      helpers.sendJson(res, 404, { error: "run_not_found_or_finished", message: runId });
      return true;
    }
    const ok = await service.abort(runId);
    if (!ok) {
      helpers.sendJson(res, 404, { error: "run_not_found_or_finished", message: runId });
      return true;
    }
    helpers.sendJson(res, 202, { aborted: true });
    return true;
  }

  // We claim the prefix — anything unmatched is a 404 within /api/studio/chat/.
  helpers.sendJson(res, 404, {
    error: "not_found",
    message: `riptide studio chat: no route for ${method} ${pathname}`
  });
  return true;
}

function workspaceFromQuery(reqInfo: ChatRouteRequest): string | null {
  const url = new URL(reqInfo.req.url ?? "/", "http://127.0.0.1");
  return url.searchParams.get("workspace");
}

function workspaceFromBody(body: Record<string, unknown> | null | undefined): string | null {
  const raw =
    typeof body?.workspace === "string" ? body.workspace :
    typeof body?.workspaceId === "string" ? body.workspaceId : null;
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

function isServiceError(value: ChatService | ChatRouteServiceError): value is ChatRouteServiceError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "payload" in value
  );
}

function toSummary(meta: { id: string; title: string; agentId: AgentId; model: string; updatedAt: string; messageCount: number; lastError: { family: string; message: string } | null }) {
  return {
    id: meta.id,
    title: meta.title,
    agentId: meta.agentId,
    model: meta.model,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    lastError: meta.lastError
  };
}
