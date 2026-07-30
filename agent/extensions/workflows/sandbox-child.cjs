"use strict";

const vm = require("node:vm");
const sendIpc = typeof process.send === "function" ? process.send.bind(process) : undefined;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ARGS_BYTES = 256 * 1024;
const MAX_AGENT_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_PHASE_BYTES = 4 * 1024;
const MAX_AGENT_REQUESTS = 32;
const MAX_PHASE_UPDATES = 64;

for (const capability of ["getBuiltinModule", "binding", "_linkedBinding", "dlopen", "kill", "abort", "send"]) {
	try {
		Object.defineProperty(process, capability, { value: undefined, writable: false, configurable: false });
	} catch {}
}

const BOOTSTRAP = String.raw`
(() => {
	"use strict";
	const dispatch = globalThis.__hostDispatch;
	const argsEnvelope = JSON.parse(globalThis.__argsJson);
	delete globalThis.__hostDispatch;
	delete globalThis.__argsJson;
	let nextId = 0;
	let phaseCount = 0;
	const untouched = new Set();
	const active = new Set();

	function freezeDeep(value, depth = 0) {
		if (!value || typeof value !== "object" || depth > 32 || Object.isFrozen(value)) return value;
		Object.freeze(value);
		for (const key of Object.keys(value)) freezeDeep(value[key], depth + 1);
		return value;
	}

	function requestHost(payload) {
		return new Promise((resolve) => {
			const accepted = dispatch("agent", payload, resolve);
			if (accepted !== true) resolve(JSON.stringify({ ok: false, error: "Workflow host rejected the agent request" }));
		}).then((envelopeJson) => {
			const envelope = JSON.parse(envelopeJson);
			if (!envelope || envelope.ok !== true || typeof envelope.value !== "string") {
				throw new Error(envelope && typeof envelope.error === "string" ? envelope.error : "Workflow host returned an invalid agent result");
			}
			return envelope.value;
		});
	}

	function agent(prompt, options = {}) {
		const id = ++nextId;
		if (id > ${MAX_AGENT_REQUESTS}) throw new Error("Workflow exceeded ${MAX_AGENT_REQUESTS} agent calls");
		untouched.add(id);
		let operation;
		const begin = () => {
			untouched.delete(id);
			if (!operation) {
				let payload;
				try {
					payload = JSON.stringify({ id, prompt: String(prompt ?? ""), options: options && typeof options === "object" ? options : {} });
				} catch (error) {
					operation = Promise.reject(new Error("agent() arguments must be JSON serializable: " + error.message));
					return operation;
				}
				active.add(id);
				operation = requestHost(payload).then(JSON.parse).finally(() => active.delete(id));
			}
			return operation;
		};
		return Object.freeze({
			then(resolve, reject) { return begin().then(resolve, reject); },
			catch(reject) { return begin().catch(reject); },
			finally(callback) { return begin().finally(callback); },
			get [Symbol.toStringTag]() { return "Promise"; },
		});
	}

	async function parallel(thunks, options = {}) {
		if (!Array.isArray(thunks)) throw new Error("parallel() expects an array of zero-argument functions");
		const requested = options && typeof options.concurrency === "number" ? Math.floor(options.concurrency) : 4;
		if (!Number.isFinite(requested) || requested < 1) throw new Error("parallel() concurrency must be a positive integer");
		const concurrency = Math.min(4, requested, Math.max(1, thunks.length));
		const results = new Array(thunks.length);
		let cursor = 0;
		const workers = Array.from({ length: concurrency }, async () => {
			while (true) {
				const index = cursor++;
				if (index >= thunks.length) return;
				if (typeof thunks[index] !== "function") throw new Error("parallel() entries must be zero-argument functions");
				results[index] = await thunks[index]();
			}
		});
		await Promise.all(workers);
		return results;
	}

	function phase(title) {
		if (++phaseCount > ${MAX_PHASE_UPDATES}) throw new Error("Workflow exceeded ${MAX_PHASE_UPDATES} phase updates");
		const accepted = dispatch("phase", JSON.stringify({ title: String(title ?? "") }));
		if (accepted !== true) throw new Error("Workflow host rejected the phase update");
	}

	function serialize(value) {
		const seen = new WeakSet();
		return JSON.stringify(value === undefined ? null : value, (_key, item) => {
			if (typeof item === "bigint") return item.toString() + "n";
			if (item && typeof item === "object") {
				if (seen.has(item)) return "[circular]";
				seen.add(item);
			}
			return item;
		});
	}

	Object.defineProperties(globalThis, {
		args: { value: argsEnvelope.defined ? freezeDeep(argsEnvelope.value) : undefined, writable: false, configurable: false },
		agent: { value: agent, writable: false, configurable: false },
		parallel: { value: parallel, writable: false, configurable: false },
		phase: { value: phase, writable: false, configurable: false },
		__workflowState: { value: () => ({ untouched: untouched.size, active: active.size }), writable: false, configurable: false },
		__serializeWorkflowResult: { value: serialize, writable: false, configurable: false },
	});
})();
`;

let initialized = false;
let token;
let phaseCount = 0;
let requestCount = 0;
const requestIds = new Set();
const pending = new Map();

function byteLength(value) {
	return Buffer.byteLength(value, "utf8");
}

function send(message) {
	sendIpc?.({ token, ...message });
}

function fail(error) {
	send({ kind: "error", error: (error instanceof Error ? error.message : String(error)).slice(0, 16 * 1024) });
}

function execute(source, argsJson) {
	try {
		if (byteLength(source) > MAX_SOURCE_BYTES) throw new Error("Workflow source exceeds the child-process limit");
		if (byteLength(argsJson) > MAX_ARGS_BYTES) throw new Error("Workflow args exceed the child-process limit");
		const sandbox = Object.create(null);
		sandbox.__hostDispatch = (kind, payloadJson, settle) => {
			try {
			if (kind === "phase") {
				if (typeof payloadJson !== "string" || byteLength(payloadJson) > MAX_PHASE_BYTES || ++phaseCount > MAX_PHASE_UPDATES) {
					fail(new Error("Workflow phase update exceeded its IPC limit"));
					return false;
				}
				send({ kind: "phase", payloadJson });
				return true;
			}
			if (kind !== "agent" || typeof payloadJson !== "string" || typeof settle !== "function") {
				fail(new Error("Workflow sent an invalid host operation"));
				return false;
			}
			if (byteLength(payloadJson) > MAX_AGENT_BYTES || ++requestCount > MAX_AGENT_REQUESTS) {
				fail(new Error("Workflow agent request exceeded its IPC limit"));
				return false;
			}
			let id;
			try { id = JSON.parse(payloadJson).id; } catch {
				fail(new Error("Workflow sent malformed agent JSON"));
				return false;
			}
			if (!Number.isSafeInteger(id) || id < 1 || requestIds.has(id)) {
				fail(new Error("Workflow reused or sent an invalid agent request ID"));
				return false;
			}
			requestIds.add(id);
			pending.set(id, { settle });
			send({ kind: "agent", payloadJson });
			return true;
			} catch (error) {
				try { fail(error); } catch {}
				return false;
			}
		};
		sandbox.__argsJson = argsJson;
		const context = vm.createContext(sandbox, {
			name: "pi-workflow",
			codeGeneration: { strings: false, wasm: false },
		});
		new vm.Script(BOOTSTRAP, { filename: "workflow-bootstrap.js" }).runInContext(context, { timeout: 1_000 });
		const body = vm.compileFunction(
			`"use strict"; return (async () => {\n${source}\n})();`,
			["agent", "parallel", "phase", "args"],
			{ filename: "workflow-script.js", parsingContext: context },
		);
		context.__workflowBody = body;
		new vm.Script(`
			(() => {
				const body = globalThis.__workflowBody;
				delete globalThis.__workflowBody;
				globalThis.__workflowPromise = Promise.resolve(body(agent, parallel, phase, args)).then(async (value) => {
					await Promise.resolve();
					const state = __workflowState();
					if (state.untouched > 0) throw new Error("Workflow created " + state.untouched + " unawaited agent() call(s)");
					if (state.active > 0) throw new Error("Workflow returned before " + state.active + " agent call(s) settled");
					return __serializeWorkflowResult(value);
				});
			})();
		`, { filename: "workflow-invoke.js" }).runInContext(context, { timeout: 1_000 });
		Promise.resolve(context.__workflowPromise)
			.then((resultJson) => {
				if (typeof resultJson !== "string") throw new Error("Workflow result is not JSON serializable");
				if (byteLength(resultJson) > MAX_RESULT_BYTES) throw new Error("Workflow result exceeded the child-process IPC limit");
				send({ kind: "result", resultJson });
			})
			.catch(fail);
	} catch (error) {
		fail(error);
	}
}

process.on("message", (message) => {
	if (!message || typeof message !== "object") return;
	if (!initialized) {
		if (message.kind !== "init" || typeof message.token !== "string" || typeof message.source !== "string" || typeof message.argsJson !== "string") {
			process.exitCode = 1;
			return;
		}
		initialized = true;
		token = message.token;
		execute(message.source, message.argsJson);
		return;
	}
	if (message.token !== token || message.kind !== "agentResult") return;
	const request = pending.get(message.id);
	if (!request) return;
	pending.delete(message.id);
	if (typeof message.resultJson !== "string" || byteLength(message.resultJson) > MAX_AGENT_BYTES) {
		fail(new Error("Host returned an invalid or oversized agent result"));
		return;
	}
	request.settle(JSON.stringify({ ok: true, value: message.resultJson }));
});
