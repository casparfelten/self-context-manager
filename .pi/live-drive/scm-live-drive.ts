import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SelfContextManager } from "../../src/index.ts";

type AnyMessage = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  api?: string;
  provider?: string;
  model?: string;
  usage?: unknown;
  stopReason?: string;
};

let manager: SelfContextManager | null = null;

function sanitizeSessionId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (cleaned.length <= 96) return cleaned;
  return cleaned.slice(-96);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

function toHarnessMessages(messages: unknown): AnyMessage[] {
  if (!Array.isArray(messages)) return [];

  const out: AnyMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const msg = message as AnyMessage;

    if (msg.role === "user") {
      out.push({
        role: "user",
        content: typeof msg.content === "string" || Array.isArray(msg.content) ? msg.content : "",
        timestamp: Number(msg.timestamp ?? Date.now()),
      });
      continue;
    }

    if (msg.role === "assistant") {
      out.push({
        role: "assistant",
        content: Array.isArray(msg.content) ? msg.content : [{ type: "text", text: contentToText(msg.content) }],
        api: msg.api,
        provider: msg.provider,
        model: msg.model,
        usage: msg.usage,
        stopReason: msg.stopReason,
        timestamp: Number(msg.timestamp ?? Date.now()),
      });
      continue;
    }

    if (msg.role === "toolResult") {
      out.push({
        role: "toolResult",
        toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : "unknown-tool-call",
        toolName: typeof msg.toolName === "string" ? msg.toolName : "unknown-tool",
        content: Array.isArray(msg.content) ? msg.content : [{ type: "text", text: contentToText(msg.content) }],
        isError: Boolean(msg.isError),
        timestamp: Number(msg.timestamp ?? Date.now()),
      });
    }
  }

  return out;
}

function getToolPath(event: any): string | null {
  const path = event?.args?.path ?? event?.input?.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function getToolOutput(event: any): string {
  const detailsOutput = event?.result?.details?.output;
  if (typeof detailsOutput === "string") return detailsOutput;
  return contentToText(event?.result?.content);
}

async function ensureManager(ctx: any): Promise<SelfContextManager> {
  if (manager) return manager;

  const sessionFile =
    (typeof ctx?.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : null) ??
    `ephemeral-${Date.now()}`;
  const sessionId = sanitizeSessionId(String(sessionFile));

  manager = new SelfContextManager({
    sessionId,
    workspaceRoot: ctx.cwd,
    systemPrompt: "",
  });

  await manager.load();
  return manager;
}

/**
 * @impldoc Current Pi wrapper surface
 *
 * This thin wrapper wires Pi lifecycle/context/tool events into
 * `SelfContextManager`.
 *
 * Current behavior:
 * - derives one session identity from Pi's session file
 * - uses the workspace root as the runtime root
 * - relies on the runtime's default shared SQLite store for the workspace
 * - observes a small wired tool subset (`read`, `write`, `edit`, `ls`, `find`,
 *   `grep`, `bash`)
 * - exposes only `/scm-status`, `/scm-read`, and `/scm-dump`
 *
 * Important current limitation:
 * - this wrapper does not yet expose a full model-facing context-editing
 *   interface (activate/deactivate/pin/unpin/search/show), so the agent can
 *   mutate managed context indirectly but not yet through a finished deliberate
 *   CLI/control plane.
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const scm = await ensureManager(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(`SCM live-drive loaded: ${scm.sessionObjectId}`, "info");
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (!manager) return;
    await manager.close();
    manager = null;
  });

  pi.on("context", async (event, ctx) => {
    const scm = await ensureManager(ctx);
    const harnessMessages = toHarnessMessages((event as any).messages);
    const transformed = await scm.transformContext(harnessMessages as any);
    return { messages: transformed as any };
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const scm = await ensureManager(ctx);

    if ((event as any).isError) return;

    try {
      const toolName = (event as any).toolName;

      if (toolName === "read") {
        const path = getToolPath(event);
        if (path) await scm.read(path);
        return;
      }

      if (toolName === "write" || toolName === "edit") {
        const path = getToolPath(event);
        if (path) await scm.wrappedEdit(path);
        return;
      }

      if (toolName === "ls") {
        const output = getToolOutput(event);
        if (output.length > 0) await scm.wrappedLs(output);
        return;
      }

      if (toolName === "find") {
        const output = getToolOutput(event);
        if (output.length > 0) await scm.wrappedFind(output);
        return;
      }

      if (toolName === "grep") {
        const output = getToolOutput(event);
        if (output.length > 0) await scm.wrappedGrep(output);
        return;
      }

      if (toolName === "bash") {
        const command = typeof (event as any).args?.command === "string" ? (event as any).args.command : "";
        const output = getToolOutput(event);
        await scm.observeToolExecutionEnd("bash", `${command}\n${output}`.trim());
      }
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(`SCM tool sync error: ${String((error as Error)?.message ?? error)}`, "error");
      } else {
        console.error(`SCM tool sync error: ${String((error as Error)?.message ?? error)}`);
      }
    }
  });

  pi.registerCommand("scm-status", {
    description: "Show SelfContextManager snapshot summary",
    handler: async (_args, ctx) => {
      const scm = await ensureManager(ctx);
      const snapshot = scm.getSnapshot();
      const line = [
        `scm_status session=${scm.sessionObjectId}`,
        `metadata=${snapshot.metadataPool.length}`,
        `active=${snapshot.activeSet.size}`,
        `pinned=${snapshot.pinnedSet.size}`,
      ].join(" ");

      if (ctx.hasUI) ctx.ui.notify(line, "info");
      console.log(line);
    },
  });

  pi.registerCommand("scm-read", {
    description: "Index a file into SCM: /scm-read <path>",
    handler: async (args, ctx) => {
      const scm = await ensureManager(ctx);
      const path = String(args ?? "").trim();
      if (!path) {
        const msg = "usage: /scm-read <path>";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        console.log(msg);
        return;
      }

      const result = await scm.read(path);
      const line = `scm_read ok=${result.ok} id=${result.id ?? ""}`.trim();
      if (ctx.hasUI) ctx.ui.notify(line, "info");
      console.log(line);
    },
  });

  pi.registerCommand("scm-dump", {
    description: "Write SCM snapshot to JSON file: /scm-dump [path]",
    handler: async (args, ctx) => {
      const scm = await ensureManager(ctx);
      const snapshot = scm.getSnapshot();
      const outputPath =
        String(args ?? "").trim() || resolve(ctx.cwd, ".pi", "scm-live-drive-snapshot.json");

      const json = JSON.stringify(
        {
          sessionObjectId: scm.sessionObjectId,
          metadataPool: snapshot.metadataPool,
          activeSet: [...snapshot.activeSet],
          pinnedSet: [...snapshot.pinnedSet],
        },
        null,
        2,
      );

      await writeFile(outputPath, `${json}\n`, "utf8");
      const line = `scm_dump path=${outputPath}`;
      if (ctx.hasUI) ctx.ui.notify(line, "info");
      console.log(line);
    },
  });
}
