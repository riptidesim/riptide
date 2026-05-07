// Filesystem-backed persistence for chat threads.
//
// Layout under <workspace>/.riptide/studio/threads/:
//   sessions.json              - threadId -> { agentId, model, sessionId, ... }
//   <threadId>.meta.json       - thread metadata (title, agent, model, counters)
//   <threadId>.jsonl           - append-only message log (user/assistant/system/error)
//
// Append happens at terminal events (done/error), never per delta. Meta
// and sessions files are rewritten via write-temp + rename for atomicity.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AgentId,
  ChatErrorFamily,
  ChatThreadSummary,
  JsonlLine,
  SessionRecord,
  SessionsFile,
  ThreadMeta
} from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ChatStoreOptions {
  workspacePath: string;
}

export class ChatStore {
  private readonly workspace: string;
  private readonly root: string;
  private readonly metaCache = new Map<string, ThreadMeta>();
  private sessions: SessionsFile = {
    schemaVersion: "studio-chat-sessions.v1",
    threads: {}
  };
  private hydrated = false;

  constructor(opts: ChatStoreOptions) {
    this.workspace = opts.workspacePath;
    this.root = path.join(opts.workspacePath, ".riptide", "studio", "threads");
  }

  workspacePath(): string {
    return this.workspace;
  }

  rootDir(): string {
    return this.root;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      await mkdir(this.root, { recursive: true });
    } catch {
      // Best effort — if mkdir fails, subsequent ops will surface a clearer error.
    }
    // Read sessions.json (tolerate missing/corrupt — treat as empty).
    try {
      const raw = await readFile(path.join(this.root, "sessions.json"), "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionsFile>;
      if (parsed && typeof parsed === "object" && parsed.threads && typeof parsed.threads === "object") {
        this.sessions = {
          schemaVersion: "studio-chat-sessions.v1",
          threads: parsed.threads as Record<string, SessionRecord>
        };
      }
    } catch {
      // No sessions file yet, or unreadable — start clean.
    }
    // Index meta files.
    try {
      const entries = await readdir(this.root);
      for (const name of entries) {
        if (!name.endsWith(".meta.json")) continue;
        const id = name.slice(0, -".meta.json".length);
        if (!UUID_RE.test(id)) continue;
        const meta = await this.readMeta(id);
        if (meta) this.metaCache.set(id, meta);
      }
    } catch {
      // Directory missing or unreadable — nothing to hydrate.
    }
    // Reconcile sessions entries that have no meta file.
    for (const id of Object.keys(this.sessions.threads)) {
      if (!this.metaCache.has(id)) {
        delete this.sessions.threads[id];
      }
    }
    await this.writeSessionsLocked();
  }

  listThreads(): ChatThreadSummary[] {
    const out: ChatThreadSummary[] = [];
    for (const meta of this.metaCache.values()) {
      out.push({
        id: meta.id,
        title: meta.title,
        agentId: meta.agentId,
        model: meta.model,
        updatedAt: meta.updatedAt,
        messageCount: meta.messageCount,
        lastError: meta.lastError
      });
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return out;
  }

  getThread(id: string): ThreadMeta | null {
    return this.metaCache.get(id) ?? null;
  }

  getSession(id: string): SessionRecord | null {
    return this.sessions.threads[id] ?? null;
  }

  async createThread(input: { agentId: AgentId; model: string; title?: string }): Promise<ThreadMeta> {
    await this.hydrate();
    const id = randomUUID();
    const now = new Date().toISOString();
    const meta: ThreadMeta = {
      schemaVersion: "studio-chat-thread.v1",
      id,
      title: (input.title ?? "New conversation").slice(0, 120),
      agentId: input.agentId,
      model: input.model,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastError: null
    };
    await this.writeMeta(meta);
    this.metaCache.set(id, meta);
    this.sessions.threads[id] = {
      agentId: input.agentId,
      model: input.model,
      sessionId: null,
      updatedAt: now
    };
    await this.writeSessionsLocked();
    return meta;
  }

  async deleteThread(id: string): Promise<void> {
    await this.hydrate();
    if (!UUID_RE.test(id)) return;
    this.metaCache.delete(id);
    delete this.sessions.threads[id];
    await Promise.allSettled([
      rm(path.join(this.root, `${id}.meta.json`), { force: true }),
      rm(path.join(this.root, `${id}.jsonl`), { force: true })
    ]);
    await this.writeSessionsLocked();
  }

  async readMessages(id: string): Promise<JsonlLine[]> {
    if (!UUID_RE.test(id)) return [];
    let raw = "";
    try {
      raw = await readFile(path.join(this.root, `${id}.jsonl`), "utf8");
    } catch {
      return [];
    }
    const out: JsonlLine[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as JsonlLine);
      } catch {
        // Skip corrupt lines so one bad write doesn't poison the whole thread.
      }
    }
    return out;
  }

  async appendLines(id: string, lines: JsonlLine[]): Promise<void> {
    if (!UUID_RE.test(id) || lines.length === 0) return;
    await mkdir(this.root, { recursive: true });
    const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    const fp = path.join(this.root, `${id}.jsonl`);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(fp, body, "utf8");
  }

  async updateMetaAfterTurn(input: {
    threadId: string;
    addedMessages: number;
    titleFromUser?: string;
    lastError: { family: ChatErrorFamily; message: string } | null;
  }): Promise<void> {
    const existing = this.metaCache.get(input.threadId);
    if (!existing) return;
    const now = new Date().toISOString();
    const next: ThreadMeta = {
      ...existing,
      updatedAt: now,
      messageCount: existing.messageCount + input.addedMessages,
      lastError: input.lastError
    };
    if (existing.title === "New conversation" && input.titleFromUser) {
      next.title = input.titleFromUser.slice(0, 120);
    }
    await this.writeMeta(next);
    this.metaCache.set(input.threadId, next);
  }

  async updateSession(id: string, sessionId: string | null): Promise<void> {
    const existing = this.sessions.threads[id];
    if (!existing) return;
    this.sessions.threads[id] = {
      ...existing,
      sessionId,
      updatedAt: new Date().toISOString()
    };
    await this.writeSessionsLocked();
  }

  private async readMeta(id: string): Promise<ThreadMeta | null> {
    try {
      const raw = await readFile(path.join(this.root, `${id}.meta.json`), "utf8");
      const parsed = JSON.parse(raw) as ThreadMeta;
      if (parsed && parsed.schemaVersion === "studio-chat-thread.v1" && parsed.id === id) {
        return parsed;
      }
    } catch {
      // Missing or unreadable meta — caller treats as absent.
    }
    return null;
  }

  private async writeMeta(meta: ThreadMeta): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const tmp = path.join(this.root, `${meta.id}.meta.json.${process.pid}.tmp`);
    const dest = path.join(this.root, `${meta.id}.meta.json`);
    await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
    await rename(tmp, dest);
  }

  private async writeSessionsLocked(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const tmp = path.join(this.root, `sessions.json.${process.pid}.tmp`);
    const dest = path.join(this.root, "sessions.json");
    await writeFile(tmp, JSON.stringify(this.sessions, null, 2), "utf8");
    await rename(tmp, dest);
  }
}

export function isValidThreadId(id: string): boolean {
  return UUID_RE.test(id);
}
