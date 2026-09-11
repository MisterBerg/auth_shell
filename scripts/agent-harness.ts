/**
 * agent-harness.ts
 *
 * Standalone debug harness for the agent-chat module's tool-calling loop. It sends the *exact*
 * same request shape to OpenAI's Responses API, against the *exact* same bridge-backed tool
 * schemas, as modules/agent-chat/src/index.tsx's runAgentSession/executeTool — but from a plain
 * Node script instead of a browser tab, with every request and response printed in full. That's
 * the point: the browser chat only ever shows you the final assistant text and a one-line "Calling
 * X" note per tool call, which isn't enough to tell whether the model is confused by a tool's
 * description/schema or by the system prompt. This prints everything so prompt/tool-schema changes
 * (or future "skill" docs) can be iterated on without digging through devtools.
 *
 * Deliberately out of scope: the organizer/work-scope/asset/module-registry tools. Those execute
 * against browser-held AWS credentials and a live project's S3/DynamoDB state (see executeTool in
 * index.tsx) — there's no clean way to drive them from a bare Node script. This harness's own
 * always-on tool set only covers the local-runtime (agent-bridge) tools: filesystem, shell,
 * Python, PDF, and TCP/HTTP device access — the same CORE_TOOL_DEFINITIONS split agent-chat uses.
 *
 * Everything module-specific (e.g. test-manager's spec tools) is no longer a static tool at all —
 * it's an AgentSkill a mounted module registers live in the browser (see useRegisterAgentSkills in
 * module-core). This harness has no browser of its own, so it reaches those the same way an
 * external CLI agent would: list_agent_skills/use_skill here call the bridge's get_appspace_context
 * RPC and read the agentModuleSkills field a live agent-chat tab keeps synced there (see
 * buildAppspaceContextSnapshot in index.tsx). That means real skills only show up if a browser tab
 * running the app is open with the local runtime enabled; otherwise you'll just see an empty list.
 *
 * Prerequisites: the local agent-bridge running (`npm run bridge:local`, or already running as
 * part of `npm run run:local`) and an OpenAI API key in OPENAI_API_KEY.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx scripts/agent-harness.ts
 *     Interactive REPL. Each line you type is one user turn in a running conversation, exactly
 *     like typing into the chat panel. Type "exit" or Ctrl+C to quit.
 *
 *   OPENAI_API_KEY=sk-... npx tsx scripts/agent-harness.ts --task="list files in the workspace root"
 *     Single turn, prints the transcript, exits. Good for scripted A/B prompt comparisons.
 *
 * Flags:
 *   --model=gpt-5.4-mini              Must be one of agent-chat's supported models.
 *   --bridge=http://127.0.0.1:4317    Agent bridge URL.
 *   --system=path/to/file.txt         Replaces the built-in base system prompt entirely.
 *   --skills=scripts/agent-skills     Directory of .md files appended (sorted by filename) to the
 *                                     system prompt as additional instructions — this is the "skill
 *                                     framework" experimentation surface: drop a .md file describing
 *                                     how to use a tool well, re-run, see if behavior improves.
 *   --max-iterations=20               Matches production's TOOL_ITERATION_LIMIT by default.
 *   --log=logs/agent-harness/foo.log  Defaults to a timestamped file under logs/agent-harness/.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { extname, join, resolve } from "path";
import { createInterface } from "readline/promises";
import type { AgentModuleSkills } from "module-core";

// ---------------------------------------------------------------------------
// Types — copied 1:1 from modules/agent-chat/src/index.tsx so requests/responses match production
// exactly. Keep in sync by hand if that file's shapes change.
// ---------------------------------------------------------------------------

type ResponsesApiOutputText = { type?: string; text?: string };
type ResponsesApiMessage = { type?: string; role?: string; content?: ResponsesApiOutputText[] };
type ResponsesApiFunctionCall = { type: "function_call"; call_id: string; name: string; arguments: string };
type ResponsesApiOutputItem = ResponsesApiMessage | ResponsesApiFunctionCall | { type?: string; [key: string]: unknown };
type ResponsesApiResponse = { output_text?: string; output?: ResponsesApiOutputItem[]; error?: { message?: string } };
type InputMessageItem = {
  type: "message";
  role: "user" | "assistant";
  content: Array<{ type: "input_text"; text: string } | { type: "output_text"; text: string }>;
};
type FunctionCallOutputItem = { type: "function_call_output"; call_id: string; output: string };
type InputItem = InputMessageItem | ResponsesApiOutputItem | FunctionCallOutputItem;
type ToolDefinition = { type: "function"; name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
type ChatTurn = { role: "user" | "assistant"; text: string };

// ---------------------------------------------------------------------------
// Tool schemas — exact copies of the bridge-backed subset of CORE_TOOL_DEFINITIONS in
// modules/agent-chat/src/index.tsx (search for `name: "list_workspace_files"` etc. there), plus
// list_agent_skills/use_skill (also real production tools now — see executeTool's cases there).
// ---------------------------------------------------------------------------

const CORE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    name: "list_workspace_files",
    description: "List files and directories from the local workspace bridge.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_workspace_file",
    description: "Read a file from the local workspace bridge.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_workspace_file",
    description: "Write a file through the local workspace bridge.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        mode: { type: "string", enum: ["overwrite", "append"] },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_workspace_command",
    description: "Run a shell command through the local workspace bridge.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 600000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "execute_tcp_command",
    description: "Open a raw TCP connection through the local workspace bridge, optionally send a command, and read the response. Useful for SCPI/LAN instruments such as oscilloscopes and power supplies.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        command: { type: "string" },
        appendNewline: { type: "boolean" },
        newline: { type: "string", enum: ["lf", "crlf", "none"] },
        readMode: { type: "string", enum: ["once", "until-timeout", "until-marker"] },
        readUntil: { type: "string" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 600000 },
        quietMs: { type: "integer", minimum: 50, maximum: 10000 },
        sendDelayMs: { type: "integer", minimum: 0, maximum: 10000 },
        encoding: { type: "string", enum: ["utf8", "base64", "hex"] },
      },
      required: ["host"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_python_environment",
    description: "Inspect the managed local Python environment and its approved dependency allowlist.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "check_python_dependencies",
    description: "Check whether approved Python packages are already installed in the managed environment.",
    parameters: {
      type: "object",
      properties: { packages: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } },
      required: ["packages"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "install_python_dependencies",
    description: "Install approved, pinned Python packages into the managed environment. Fails for packages outside the allowlist.",
    parameters: {
      type: "object",
      properties: { packages: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } },
      required: ["packages"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_python_script",
    description: "Run a Python script through the managed local Python environment.",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 600000 },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "extract_pdf_text",
    description: "Extract text from a PDF file through the local workspace bridge.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, maxPages: { type: "integer", minimum: 1, maximum: 500 } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "execute_http_request",
    description: "Make an HTTP request through the local workspace bridge. Useful for local HTTP-mode instrument adapters (e.g. a camera or capture server listening on 127.0.0.1) that don't speak raw SCPI/TCP.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
        encoding: { type: "string", enum: ["utf8", "base64"] },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_agent_skills",
    description: "List the agent skills currently on offer, one entry per mounted module instance that has registered any. Each skill is just an id and a one-line description here — call use_skill to get its full instructions and the specific tools it unlocks before acting on that module's data.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "use_skill",
    description: "Fetch full instructions and the tool definitions for one skill returned by list_agent_skills. The returned tools become callable for the rest of this run.",
    parameters: {
      type: "object",
      properties: {
        instanceId: { type: "string", description: "The instanceId from list_agent_skills identifying which mounted module instance offers this skill." },
        skillId: { type: "string", description: "The skill's id from list_agent_skills." },
      },
      required: ["instanceId", "skillId"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ---------------------------------------------------------------------------
// Base system prompt — copied verbatim from DEFAULT_PROMPT in index.tsx. Override with --system.
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT = [
  "You are helping build and evolve this workspace.",
  "Use the provided workspace tools whenever project structure, assets, resources, or modules are relevant.",
  "By default, treat 'the app', 'the webapp', 'app data', 'documentation here', and similar phrases as referring to the active project configuration, project assets, and registered resources inside the web app.",
  "Prefer project assets, registered resources, and root-config information before searching the local bridge workspace unless the user explicitly says workspace, local files, repo, filesystem, or disk, or recent conversation is clearly about local workspace operations.",
  "Prefer module-native tools for task tracker, work manager, test manager, documentation, markdown, document-viewer, links, and webview data when they are available instead of editing their backing files indirectly.",
  "Use shell commands only when no better dedicated tool is available, and pay attention to command failures.",
  "Prefer the managed Python tools for parsing, transformations, text extraction, and small file-oriented programs instead of shell-embedded Python.",
  "Only install Python packages through the dedicated dependency installer, and only when a missing dependency blocks the task.",
  "When using run_workspace_command, provide the shell body only. Do not prefix it with powershell, pwsh, cmd, or sh.",
  "On Windows, assume the bridge will run the command inside PowerShell; set $ErrorActionPreference='Stop' and ensure parent directories exist first when needed.",
  "If a tool returns an error, read it carefully, explain what failed if asked, and change approach instead of pretending the tool succeeded.",
  "When changing the workspace, explain what you changed and why.",
  "Do not claim a change happened unless the tool call succeeded.",
].join(" ");

const HARNESS_CONTEXT = [
  "You are running inside a debug harness for local-runtime tools only.",
  "There is no project, no organizer, no assets, and no other module data available in this session — only the local workspace bridge (filesystem, shell, Python, PDF, TCP, HTTP).",
  "Do not reference organizer items, work scopes, project assets, or other modules; those tools do not exist here.",
].join(" ");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args: Record<string, string> = {};
  for (const raw of process.argv.slice(2)) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]!] = match[2]!;
  }
  return {
    task: args["task"],
    model: args["model"] ?? "gpt-5.4-mini",
    bridgeUrl: (args["bridge"] ?? "http://127.0.0.1:4317").replace(/\/$/, ""),
    systemPath: args["system"],
    skillsDir: args["skills"],
    maxIterations: args["max-iterations"] ? Number(args["max-iterations"]) : 20,
    logPath: args["log"],
  };
}

// ---------------------------------------------------------------------------
// Bridge client — mirrors callBridge in index.tsx exactly.
// ---------------------------------------------------------------------------

async function callBridge<T>(bridgeUrl: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${bridgeUrl}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const payload = (await response.json()) as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Bridge call failed: ${response.status}`);
  }
  return payload.result as T;
}

async function checkBridgeHealth(bridgeUrl: string): Promise<{ name?: string; capabilities?: string[] }> {
  const response = await fetch(`${bridgeUrl}/health`);
  const payload = (await response.json()) as { ok?: boolean; result?: { name?: string; capabilities?: string[] }; error?: string };
  if (!response.ok || !payload.ok || !payload.result) {
    throw new Error(payload.error || `Bridge health check failed: ${response.status}`);
  }
  return payload.result;
}

function parseToolArgs<T>(raw: string): T {
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Tool execution — mirrors the bridge-backed cases in executeTool (index.tsx).
// ---------------------------------------------------------------------------

type HarnessToolResult = { output: string; toolMessage?: string; unlockedTools?: ToolDefinition[] };

/**
 * Fetches the bridge's cached appspace context and returns whatever agent-chat last synced there
 * (see buildAppspaceContextSnapshot in index.tsx) — in particular its agentModuleSkills field.
 * Throws with a clear, harness-friendly message if no browser tab has ever synced one.
 */
async function fetchLiveModuleSkills(bridgeUrl: string): Promise<AgentModuleSkills[]> {
  const result = await callBridge<{ context?: { agentModuleSkills?: AgentModuleSkills[] } }>(bridgeUrl, "get_appspace_context", {});
  return result.context?.agentModuleSkills ?? [];
}

async function executeTool(bridgeUrl: string, name: string, argsJson: string): Promise<HarnessToolResult> {
  switch (name) {
    case "list_workspace_files": {
      const parsed = parseToolArgs<{ path?: string; recursive?: boolean; limit?: number }>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "list_workspace_files", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: "Listed files from the local workspace bridge." };
    }
    case "read_workspace_file": {
      const parsed = parseToolArgs<{ path: string; encoding?: string }>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "read_workspace_file", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: `Read workspace file ${parsed.path}.` };
    }
    case "write_workspace_file": {
      const parsed = parseToolArgs<{ path: string; content: string; encoding?: string; mode?: string }>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "write_workspace_file", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: `Wrote workspace file ${parsed.path}.` };
    }
    case "run_workspace_command": {
      const parsed = parseToolArgs<{ command: string; cwd?: string; timeoutMs?: number }>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "run_workspace_command", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: `Ran workspace command: ${parsed.command}` };
    }
    case "execute_tcp_command": {
      const parsed = parseToolArgs<Record<string, unknown>>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "execute_tcp_command", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: `Sent TCP command to ${parsed["host"]}:${parsed["port"] ?? "?"}.` };
    }
    case "execute_http_request": {
      const parsed = parseToolArgs<Record<string, unknown>>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "execute_http_request", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: `${parsed["method"] ?? "GET"} ${parsed["url"]}` };
    }
    case "get_python_environment": {
      const result = await callBridge<unknown>(bridgeUrl, "get_python_environment");
      return { output: JSON.stringify(result, null, 2), toolMessage: "Loaded the managed Python environment details." };
    }
    case "check_python_dependencies": {
      const parsed = parseToolArgs<{ packages: string[] }>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "check_python_dependencies", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: `Checked Python dependencies: ${parsed.packages.join(", ")}.` };
    }
    case "install_python_dependencies": {
      const parsed = parseToolArgs<{ packages: string[] }>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "install_python_dependencies", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: `Installed approved Python dependencies: ${parsed.packages.join(", ")}.` };
    }
    case "run_python_script": {
      const parsed = parseToolArgs<{ script: string; cwd?: string; timeoutMs?: number }>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "run_python_script", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: "Ran a Python script in the managed local environment." };
    }
    case "extract_pdf_text": {
      const parsed = parseToolArgs<{ path: string; maxPages?: number }>(argsJson);
      const result = await callBridge<unknown>(bridgeUrl, "extract_pdf_text", parsed);
      return { output: JSON.stringify(result, null, 2), toolMessage: `Extracted PDF text from ${parsed.path}.` };
    }
    case "list_agent_skills": {
      const liveModules = await fetchLiveModuleSkills(bridgeUrl);
      const modules = liveModules.map((entry) => ({
        instanceId: entry.instanceId,
        moduleName: entry.moduleName,
        displayName: entry.displayName,
        description: entry.description,
        skills: entry.skills.map((skill) => ({ id: skill.id, description: skill.description })),
      }));
      return {
        output: JSON.stringify({ modules }, null, 2),
        toolMessage: modules.length
          ? `Listed ${modules.reduce((sum, m) => sum + m.skills.length, 0)} skill(s) across ${modules.length} mounted module instance(s).`
          : "No mounted module instance has registered any agent skills (is a browser tab open with the local runtime enabled?).",
      };
    }
    case "use_skill": {
      const parsed = parseToolArgs<{ instanceId: string; skillId: string }>(argsJson);
      const liveModules = await fetchLiveModuleSkills(bridgeUrl);
      const moduleEntry = liveModules.find((entry) => entry.instanceId === parsed.instanceId);
      const skill = moduleEntry?.skills.find((candidate) => candidate.id === parsed.skillId);
      if (!moduleEntry || !skill) {
        throw new Error(`No skill "${parsed.skillId}" found for instanceId "${parsed.instanceId}". Call list_agent_skills first.`);
      }
      return {
        output: JSON.stringify({ prompt: skill.prompt, tools: skill.tools.map((tool) => tool.name) }, null, 2),
        toolMessage: `Loaded skill "${skill.id}" from ${moduleEntry.displayName}: ${skill.tools.map((tool) => tool.name).join(", ") || "(no tools)"}.`,
        unlockedTools: skill.tools as ToolDefinition[],
      };
    }
    default:
      throw new Error(`Unsupported tool in harness: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// OpenAI Responses API call — mirrors createOpenAiResponse in index.tsx exactly.
// ---------------------------------------------------------------------------

async function createOpenAiResponse(args: {
  apiKey: string;
  input: InputItem[];
  model: string;
  instructions: string;
  tools: ToolDefinition[];
}): Promise<ResponsesApiResponse> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify({
      model: args.model,
      input: args.input,
      instructions: args.instructions,
      tools: args.tools,
      parallel_tool_calls: true,
    }),
  });
  const payload = (await response.json()) as ResponsesApiResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message || `OpenAI request failed with status ${response.status}.`);
  }
  return payload;
}

function extractAssistantText(response: ResponsesApiResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text.trim();
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    const message = item as ResponsesApiMessage;
    if (message.role !== "assistant") continue;
    for (const content of message.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n\n").trim();
}

function toInputItems(history: ChatTurn[]): InputMessageItem[] {
  return history.map((turn) => ({
    type: "message",
    role: turn.role,
    content: [{ type: turn.role === "user" ? "input_text" : "output_text", text: turn.text }],
  }));
}

// ---------------------------------------------------------------------------
// Logging — full untruncated content goes to the log file; console gets a readable, truncated view.
// ---------------------------------------------------------------------------

let logPath = "";

function toLog(text: string): void {
  appendFileSync(logPath, `${text}\n`);
}

function truncate(value: string, max = 1200): string {
  return value.length > max ? `${value.slice(0, max)}\n... [truncated ${value.length - max} more chars, see log file for full content]` : value;
}

function section(title: string): void {
  const line = `\n${"=".repeat(8)} ${title} ${"=".repeat(8)}`;
  console.log(line);
  toLog(line);
}

function show(label: string, content: string): void {
  console.log(`\n--- ${label} ---\n${truncate(content)}`);
  toLog(`\n--- ${label} ---\n${content}`);
}

// ---------------------------------------------------------------------------
// The loop — mirrors runAgentSession in index.tsx (minus browser-only compaction/continuation,
// which don't matter for the short, single-purpose tasks this harness is meant to probe).
// ---------------------------------------------------------------------------

async function runTurn(opts: {
  apiKey: string;
  model: string;
  bridgeUrl: string;
  instructions: string;
  history: ChatTurn[];
  maxIterations: number;
}): Promise<string> {
  let inputItems: InputItem[] = toInputItems(opts.history);
  // Starts at just the core tools; grows as use_skill calls unlock more — mirrors activeTools in
  // production's runAgentSession. Resets to core-only on the next runTurn call (i.e. next REPL line).
  const activeTools: ToolDefinition[] = [...CORE_TOOL_DEFINITIONS];

  for (let i = 0; i < opts.maxIterations; i++) {
    section(`iteration ${i + 1} of ${opts.maxIterations}`);
    if (i === 0) show("instructions (system prompt) sent this turn", opts.instructions);
    show("input items sent", JSON.stringify(inputItems, null, 2));
    show("active tools this call", activeTools.map((tool) => tool.name).join(", "));

    const response = await createOpenAiResponse({
      apiKey: opts.apiKey,
      input: inputItems,
      model: opts.model,
      instructions: opts.instructions,
      tools: activeTools,
    });
    show("raw response", JSON.stringify(response, null, 2));

    const functionCalls = (response.output ?? []).filter(
      (item): item is ResponsesApiFunctionCall =>
        item.type === "function_call" && typeof (item as ResponsesApiFunctionCall).name === "string"
    );

    if (!functionCalls.length) {
      const text = extractAssistantText(response) || "(model returned no text output)";
      show("ASSISTANT", text);
      return text;
    }

    const toolOutputs: FunctionCallOutputItem[] = [];
    for (const call of functionCalls) {
      show(`TOOL CALL: ${call.name}`, call.arguments || "{}");
      let output: string;
      try {
        const result = await executeTool(opts.bridgeUrl, call.name, call.arguments);
        output = result.output;
        show(`TOOL RESULT: ${call.name}`, result.toolMessage ? `${result.toolMessage}\n\n${output}` : output);
        if (result.unlockedTools?.length) {
          for (const tool of result.unlockedTools) {
            const existingIndex = activeTools.findIndex((candidate) => candidate.name === tool.name);
            if (existingIndex >= 0) activeTools[existingIndex] = tool;
            else activeTools.push(tool);
          }
        }
      } catch (error) {
        output = JSON.stringify({ error: (error as Error).message });
        show(`TOOL ERROR: ${call.name}`, (error as Error).message);
      }
      toolOutputs.push({ type: "function_call_output", call_id: call.call_id, output });
    }

    inputItems = [...inputItems, ...(response.output ?? []), ...toolOutputs];
  }

  const text = `(hit the ${opts.maxIterations}-iteration limit without a final answer)`;
  show("ASSISTANT", text);
  return text;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function buildInstructions(systemPath: string | undefined, skillsDir: string | undefined): string {
  const base = systemPath ? readFileSync(resolve(systemPath), "utf-8").trim() : DEFAULT_PROMPT;
  const parts = [base, HARNESS_CONTEXT];
  if (skillsDir) {
    const dir = resolve(skillsDir);
    if (!existsSync(dir)) throw new Error(`--skills directory not found: ${dir}`);
    const files = readdirSync(dir).filter((name) => extname(name) === ".md").sort();
    for (const file of files) {
      parts.push(`--- skill: ${file} ---\n${readFileSync(join(dir, file), "utf-8").trim()}`);
    }
    console.log(`Loaded ${files.length} skill file(s) from ${dir}: ${files.join(", ") || "(none found)"}`);
  }
  return parts.join(" ");
}

async function main() {
  const opts = parseArgs();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) {
    console.error("Set OPENAI_API_KEY in your environment first, e.g.:\n  OPENAI_API_KEY=sk-... npx tsx scripts/agent-harness.ts");
    process.exit(1);
  }

  console.log(`Checking agent bridge at ${opts.bridgeUrl}...`);
  try {
    const health = await checkBridgeHealth(opts.bridgeUrl);
    console.log(`Bridge OK: ${health.name ?? "unknown"} — capabilities: ${(health.capabilities ?? []).join(", ")}`);
  } catch (error) {
    console.error(`Could not reach the agent bridge at ${opts.bridgeUrl}: ${(error as Error).message}`);
    console.error("Start it with `npm run bridge:local` (or `npm run run:local`, which starts it for you) and try again.");
    process.exit(1);
  }

  logPath = resolve(opts.logPath ?? join("logs", "agent-harness", `${new Date().toISOString().replace(/[:.]/g, "-")}.log`));
  mkdirSync(join(logPath, ".."), { recursive: true });
  console.log(`Model: ${opts.model}`);
  console.log(`Full transcript being written to: ${logPath}`);

  const instructions = buildInstructions(opts.systemPath, opts.skillsDir);
  const history: ChatTurn[] = [];

  const runOneTurn = async (userText: string) => {
    history.push({ role: "user", text: userText });
    const assistantText = await runTurn({
      apiKey,
      model: opts.model,
      bridgeUrl: opts.bridgeUrl,
      instructions,
      history,
      maxIterations: opts.maxIterations,
    });
    history.push({ role: "assistant", text: assistantText });
  };

  if (opts.task) {
    section(`USER: ${opts.task}`);
    try {
      await runOneTurn(opts.task);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      toLog(`\n--- ERROR ---\n${(error as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  console.log('\nInteractive mode. Type a task and press Enter ("exit" to quit).\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }
    if (trimmed === "exit" || trimmed === "quit") break;
    section(`USER: ${trimmed}`);
    try {
      await runOneTurn(trimmed);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      toLog(`\n--- ERROR ---\n${(error as Error).message}`);
    }
    rl.prompt();
  }
  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
