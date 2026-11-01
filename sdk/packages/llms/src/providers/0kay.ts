import type { ApiStream, ApiStreamChunk, HandlerModelInfo, Message, ToolDefinition } from "./types";
import type { ApiHandler } from "./handler";

/**
 * A provider that answers through the local 0kay-agent instead of a model API.
 *
 * Why not a plain HTTP model provider: the agent owns the tools, the workspace
 * policy and the approval rules. Pointing the IDE at a model directly would give
 * this fork a second, weaker copy of all three. So the conversation goes to the
 * local agent and the text comes back — the agent decides what to read and write.
 *
 * Consequence worth knowing: with this provider active, Cline's own tool loop is
 * idled. The tools run on the agent side. That is the intended division —
 * 0kay-ide is a workspace client for 0kay-agent, not a second agent.
 */

export interface CoreAgentConfig {
	/** Core's HTTP endpoint. The agent is reached through it, not directly. */
	baseUrl?: string;
	/** Which agent personality to run, when several are installed. */
	agentType?: string;
	/** Session to keep the conversation in; created on first use when empty. */
	sessionId?: string;
	/** Polling fallback when the event stream is unavailable. */
	pollMs?: number;
}

const DEFAULT_BASE = "http://127.0.0.1:8080";

type TaskRow = {
	task_id: string;
	session_id?: string;
	kind?: string;
	state?: string;
	prompt?: string;
	result?: string;
};

/**
 * The agent must exist locally before anything else is worth trying.
 *
 * Failing here with a sentence a person can act on beats a generic 404 from a
 * fetch three layers down.
 */
async function requireAgent(baseUrl: string): Promise<string> {
	const response = await fetch(`${baseUrl}/api/plugins`);
	if (!response.ok) {
		throw new Error(`0kay-core is not answering at ${baseUrl} (HTTP ${response.status})`);
	}
	const plugins = (await response.json()) as Array<{ name?: string; version?: string }>;
	const agent = plugins.find((plugin) => plugin.name === "agent");
	if (!agent) {
		throw new Error("0kay-agent is not registered with 0kay-core — start it, then retry");
	}
	return agent.version || "";
}

async function ensureSession(baseUrl: string, sessionId: string): Promise<string> {
	if (sessionId) return sessionId;
	const response = await fetch(`${baseUrl}/api/agent/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title: "0kay-ide" }),
	});
	if (!response.ok) throw new Error(`could not open a session (HTTP ${response.status})`);
	const data = (await response.json()) as { session_id?: string; id?: string };
	const id = String(data.session_id || data.id || "");
	if (!id) throw new Error("core returned no session id");
	return id;
}

/** The last user turn is what the agent answers; earlier context is its own memory. */
function lastUserText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const parts = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (parts.trim()) return parts;
	}
	return "";
}

export function createCoreAgentHandler(config: CoreAgentConfig = {}): ApiHandler {
	const baseUrl = (config.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
	let sessionId = config.sessionId || "";
	let aborter: AbortController | undefined;
	let model: HandlerModelInfo = {
		id: "0kay-agent",
		info: {
			// The agent picks the model; these are placeholders so the UI has values.
			name: "0kay-agent (local)",
			contextWindow: 200_000,
			supportsImages: false,
			supportsPromptCache: false,
			inputPrice: 0,
			outputPrice: 0,
		},
	};

	return {
		getMessages(_systemPrompt: string, messages: Message[]): unknown {
			return { session_id: sessionId, prompt: lastUserText(messages), agent_type: config.agentType };
		},

		async *createMessage(
			_systemPrompt: string,
			messages: Message[],
			_tools?: ToolDefinition[],
		): ApiStream {
			aborter = new AbortController();
			try {
				await requireAgent(baseUrl);
				sessionId = await ensureSession(baseUrl, sessionId);

				const prompt = lastUserText(messages);
				if (!prompt.trim()) {
					yield { type: "text", text: "" } as ApiStreamChunk;
					return;
				}

				const sent = await fetch(`${baseUrl}/api/agent/messages`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						session_id: sessionId,
						prompt,
						...(config.agentType ? { agent_type: config.agentType } : {}),
					}),
					signal: aborter.signal,
				});
				if (!sent.ok) throw new Error(`agent refused the message (HTTP ${sent.status})`);

				// The agent reports progress on its task stream; the reply text lands in
				// the session's turns. Waiting for the turn to appear keeps this provider
				// honest — it yields what the agent actually said, not what we hoped.
				const reply = await waitForReply(baseUrl, sessionId, config.pollMs ?? 800, aborter.signal);
				if (reply) yield { type: "text", text: reply } as ApiStreamChunk;
			} finally {
				aborter = undefined;
			}
		},

		getModel(): HandlerModelInfo {
			return model;
		},

		abort(): void {
			aborter?.abort();
		},

		setAbortSignal(signal: AbortSignal | undefined): void {
			if (!signal) return;
			signal.addEventListener("abort", () => aborter?.abort(), { once: true });
		},
	};
}

/**
 * Wait for the session's last agent turn to finish, then return its text.
 *
 * Polling rather than the event stream on purpose: the stream needs a cursor and
 * a reconnect policy, and a client that only needs "the answer to my last
 * message" does not earn either. The timeout exists so a stalled run surfaces as
 * an error instead of a hung promise.
 */
async function waitForReply(
	baseUrl: string,
	sessionId: string,
	intervalMs: number,
	signal: AbortSignal,
	timeoutMs = 10 * 60 * 1000,
): Promise<string> {
	const started = Date.now();
	for (;;) {
		if (signal.aborted) throw new Error("aborted");
		if (Date.now() - started > timeoutMs) throw new Error("the agent did not answer in time");

		const response = await fetch(
			`${baseUrl}/api/agent/sessions/${encodeURIComponent(sessionId)}/turns?limit=10`,
			{ signal },
		);
		if (response.ok) {
			const data = (await response.json()) as { tasks?: TaskRow[] };
			const rows = data.tasks || [];
			const done = [...rows]
				.reverse()
				.find((row) => row.kind !== "user" && (row.result || "").trim().length > 0);
			if (done) return String(done.result || "");
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/**
 * The workspace the IDE is allowed to touch.
 *
 * It is the agent's workspace, not a directory the IDE picks on its own: the
 * agent's tools resolve relative paths against it, so a different root here would
 * mean the IDE and the agent disagree about where "src/main.ts" is.
 */
export async function resolveWorkspace(baseUrl = DEFAULT_BASE): Promise<string> {
	const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/agent/workspace`);
	if (!response.ok) throw new Error(`workspace unavailable (HTTP ${response.status})`);
	const data = (await response.json()) as { path?: string; roots?: string[] };
	return String(data.path || data.roots?.[0] || "");
}
