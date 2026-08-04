import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AsyncStatus } from "./types.ts";

const optional = Type.Optional;
const StringArray = Type.Array(Type.String());
const ContextMode = Type.Union([Type.Literal("fresh"), Type.Literal("fork")]);
const RunMode = Type.Union([Type.Literal("single"), Type.Literal("parallel"), Type.Literal("chain")]);
const RunState = Type.Union([
	Type.Literal("queued"), Type.Literal("running"), Type.Literal("complete"),
	Type.Literal("failed"), Type.Literal("paused"), Type.Literal("stopped"),
]);
const StepState = Type.Union([
	Type.Literal("pending"), Type.Literal("running"), Type.Literal("complete"),
	Type.Literal("completed"), Type.Literal("failed"), Type.Literal("paused"), Type.Literal("stopped"),
]);
const ActivityState = Type.Union([Type.Literal("active_long_running"), Type.Literal("needs_attention")]);
const CostSummarySchema = Type.Object({
	inputTokens: Type.Number(), outputTokens: Type.Number(), costUsd: Type.Number(),
}, { additionalProperties: false });
const TokenUsageSchema = Type.Object({
	input: Type.Number(), output: Type.Number(), total: Type.Number(),
}, { additionalProperties: false });
const UsageSchema = Type.Object({
	input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), cost: Type.Number(), turns: Type.Number(),
}, { additionalProperties: false });
const ModelAttemptSchema = Type.Object({
	model: Type.String(), success: Type.Boolean(),
	exitCode: optional(Type.Union([Type.Number(), Type.Null()])),
	error: optional(Type.String()),
	usage: optional(UsageSchema),
}, { additionalProperties: false });
const TurnBudgetSchema = Type.Object({
	maxTurns: Type.Number(), graceTurns: Type.Number(),
	outcome: Type.Union([Type.Literal("within-budget"), Type.Literal("wrap-up-requested"), Type.Literal("termination-deferred"), Type.Literal("exceeded")]),
	turnCount: Type.Number(),
	wrapUpRequestedAtTurn: optional(Type.Number()),
	terminationDeferredAtTurn: optional(Type.Number()),
	exceededAtTurn: optional(Type.Number()),
}, { additionalProperties: false });
const ToolBudgetSchema = Type.Object({
	soft: optional(Type.Number()), hard: Type.Number(), block: Type.Union([StringArray, Type.Literal("*")]),
	outcome: Type.Union([Type.Literal("within-budget"), Type.Literal("soft-reached"), Type.Literal("hard-blocked")]),
	toolCount: Type.Number(), softReachedAt: optional(Type.Number()), hardReachedAt: optional(Type.Number()), blockedTool: optional(Type.String()),
}, { additionalProperties: false });
const SteeringTargetSchema = Type.Object({
	index: Type.Number(),
	state: Type.Union([Type.Literal("scheduled"), Type.Literal("routed"), Type.Literal("delivered"), Type.Literal("late"), Type.Literal("failed"), Type.Literal("recovered")]),
	routedAt: optional(Type.Number()), deliveredAt: optional(Type.Number()), lateDeliveredAt: optional(Type.Number()),
	failedAt: optional(Type.Number()), recoveredAt: optional(Type.Number()), reason: optional(Type.String()), replacementRunId: optional(Type.String()),
}, { additionalProperties: false });
const SteeringStatusSchema = Type.Object({
	requested: Type.Number(), scheduled: Type.Number(), pending: Type.Number(), delivered: Type.Number(), failed: Type.Number(), recovered: Type.Number(),
	lastRequestedAt: optional(Type.Number()), lastDeliveredAt: optional(Type.Number()),
	recent: Type.Array(Type.Object({
		id: Type.String(), requestedAt: Type.Number(), source: optional(Type.String()), messagePreview: Type.String(), targets: Type.Array(SteeringTargetSchema),
	}, { additionalProperties: false })),
}, { additionalProperties: false });
const ChildWatchdogSchema = Type.Object({
	phase: Type.Union([Type.Literal("idle"), Type.Literal("reviewing"), Type.Literal("autofollow"), Type.Literal("settling"), Type.Literal("stale"), Type.Literal("failed")]),
	seq: Type.Number(), lastUpdate: Type.Number(), followUpPending: Type.Boolean(), reason: optional(Type.String()), timedOut: optional(Type.Boolean()),
}, { additionalProperties: false });

const ProcessTerminalBase = {
	version: Type.Literal(1), runId: Type.String(), childIndex: optional(Type.Number()), runnerProcessInstanceId: Type.String(),
	resumeDisposition: optional(Type.Union([Type.Literal("resumable"), Type.Literal("non-resumable"), Type.Literal("unavailable")])),
};
const ProcessExitBase = {
	processInstanceId: Type.String(), closeObservedAt: Type.Number(), exitCode: Type.Union([Type.Number(), Type.Null()]), signal: Type.Union([Type.String(), Type.Null()]),
};
const ProcessTerminalSchema = Type.Union([
	Type.Object({ ...ProcessTerminalBase, state: Type.Union([Type.Literal("pending"), Type.Literal("not-started")]) }, { additionalProperties: false }),
	Type.Object({
		...ProcessTerminalBase, state: Type.Literal("observed"), observedAt: Type.Number(),
		instances: Type.Array(Type.Union([
			Type.Object({ ...ProcessExitBase, kind: Type.Literal("runner") }, { additionalProperties: false }),
			Type.Object({ ...ProcessExitBase, kind: Type.Literal("pi-writer"), attempt: Type.Number() }, { additionalProperties: false }),
		])),
		canonicalSession: optional(Type.Object({
			canonicalSessionId: Type.String(), leaseDisposition: Type.Union([Type.Literal("released"), Type.Literal("not-held")]),
			freeAtObservation: Type.Literal(true), canonicalSessionLeaseReleased: optional(Type.Literal(true)),
		}, { additionalProperties: false })),
	}, { additionalProperties: false }),
	Type.Object({
		...ProcessTerminalBase, state: Type.Literal("unknown"),
		reason: Type.Union([
			Type.Literal("observer-unavailable"), Type.Literal("runner-candidate-missing"), Type.Literal("runner-instance-mismatch"),
			Type.Literal("writer-close-unverified"), Type.Literal("canonical-session-unavailable"), Type.Literal("canonical-session-lease-active"),
			Type.Literal("canonical-session-release-unverified"), Type.Literal("proof-write-failed"), Type.Literal("stale-repair"),
		]),
		diagnostic: optional(Type.String()),
	}, { additionalProperties: false }),
]);

const CapabilityCeilingSchema = Type.Object({
	version: Type.Literal(1), allowedTools: optional(StringArray), denyExtensions: Type.Boolean(), sources: StringArray,
}, { additionalProperties: false });
const CapabilityAuditSchema = Type.Object({
	ceiling: CapabilityCeilingSchema, requestedTools: optional(StringArray), effectiveTools: StringArray, removedTools: StringArray,
	internalTools: StringArray, extensionsDenied: Type.Boolean(), removedExtensionCount: Type.Number(), requestedMcpToolCount: Type.Number(), effectiveMcpTools: StringArray,
}, { additionalProperties: false });
const ParallelGroupSchema = Type.Object({ start: Type.Number(), count: Type.Number(), stepIndex: Type.Number() }, { additionalProperties: false });
const ParallelHandoffSchema = Type.Object({
	version: Type.Literal(1), path: Type.String(), groupCount: Type.Number(), childCount: Type.Number(), changedPatches: Type.Number(),
	cleanupState: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
}, { additionalProperties: false });

const AcceptanceEvidenceKind = Type.Union([
	Type.Literal("changed-files"), Type.Literal("tests-added"), Type.Literal("commands-run"), Type.Literal("validation-output"),
	Type.Literal("residual-risks"), Type.Literal("no-staged-files"), Type.Literal("diff-summary"), Type.Literal("review-findings"), Type.Literal("manual-notes"),
]);
const AcceptanceEvidenceStatus = Type.Union([
	Type.Literal("pending"), Type.Literal("not-required"), Type.Literal("claimed"), Type.Literal("attested"), Type.Literal("checked"), Type.Literal("verified"), Type.Literal("rejected"),
]);
const ResolvedAcceptanceGateSchema = Type.Object({
	id: Type.String(), must: Type.String(), evidence: Type.Array(AcceptanceEvidenceKind),
	severity: Type.Union([Type.Literal("required"), Type.Literal("recommended")]),
}, { additionalProperties: false });
const AcceptanceVerifyCommandSchema = Type.Object({
	id: Type.String(),
	command: Type.String(),
	timeoutMs: optional(Type.Number()),
	cwd: optional(Type.String()),
	env: optional(Type.Record(Type.String(), Type.String())),
	allowFailure: optional(Type.Boolean()),
}, { additionalProperties: false });
const ResolvedAcceptanceConfigSchema = Type.Object({
	level: Type.Union([Type.Literal("none"), Type.Literal("attested"), Type.Literal("checked"), Type.Literal("verified")]),
	explicit: Type.Boolean(), inferredReason: StringArray, criteria: Type.Array(ResolvedAcceptanceGateSchema), evidence: Type.Array(AcceptanceEvidenceKind),
	verify: Type.Array(AcceptanceVerifyCommandSchema),
	review: optional(Type.Union([Type.Object({ agent: optional(Type.String()), focus: optional(Type.String()), required: optional(Type.Boolean()) }, { additionalProperties: false }), Type.Literal(false)])),
	stopRules: StringArray, reason: optional(Type.String()),
}, { additionalProperties: false });
const AcceptanceReportSchema = Type.Object({
	criteriaSatisfied: optional(Type.Array(Type.Object({
		id: optional(Type.String()), status: Type.Union([Type.Literal("satisfied"), Type.Literal("not-satisfied"), Type.Literal("not-applicable")]), evidence: Type.String(),
	}, { additionalProperties: false }))),
	changedFiles: optional(StringArray), testsAddedOrUpdated: optional(StringArray),
	commandsRun: optional(Type.Array(Type.Object({ command: Type.String(), result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not-run")]), summary: Type.String() }, { additionalProperties: false }))),
	validationOutput: optional(StringArray), residualRisks: optional(StringArray), noStagedFiles: optional(Type.Boolean()),
	diffSummary: optional(Type.String()), reviewFindings: optional(StringArray), manualNotes: optional(Type.String()), notes: optional(Type.String()),
}, { additionalProperties: false });
const ReviewFindingSchema = Type.Object({
	severity: Type.Union([Type.Literal("blocker"), Type.Literal("non-blocking")]), file: optional(Type.String()), issue: Type.String(), rationale: Type.String(),
}, { additionalProperties: false });
const AcceptanceLedgerSchema = Type.Object({
	status: Type.Union([AcceptanceEvidenceStatus, Type.Literal("review-required"), Type.Literal("reviewed"), Type.Literal("accepted")]),
	evidenceStatus: AcceptanceEvidenceStatus, explicit: Type.Boolean(), effectiveAcceptance: ResolvedAcceptanceConfigSchema,
	inferredReason: StringArray, criteria: Type.Array(ResolvedAcceptanceGateSchema), childReport: optional(AcceptanceReportSchema), childReportParseError: optional(Type.String()),
	runtimeChecks: Type.Array(Type.Object({ id: Type.String(), status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not-applicable")]), message: Type.String() }, { additionalProperties: false })),
	verifyRuns: Type.Array(Type.Object({
		id: Type.String(), command: Type.String(), cwd: optional(Type.String()), exitCode: Type.Union([Type.Number(), Type.Null()]),
		status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("timed-out"), Type.Literal("allowed-failure")]),
		stdout: optional(Type.String()), stderr: optional(Type.String()), durationMs: Type.Number(),
	}, { additionalProperties: false })),
	reviewResult: optional(Type.Object({
		status: Type.Union([Type.Literal("review-required"), Type.Literal("reviewed"), Type.Literal("blockers")]), findings: Type.Array(ReviewFindingSchema),
	}, { additionalProperties: false })),
	parentDecision: optional(Type.Object({ status: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]), at: Type.String(), reason: optional(Type.String()) }, { additionalProperties: false })),
}, { additionalProperties: false });

const AgentContractSchema = Type.Object({ version: Type.Literal(1) }, { additionalProperties: false });
const ExecutionSchema = Type.Object({
	status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("paused"), Type.Literal("stopped"), Type.Literal("detached")]),
	success: Type.Boolean(), exitCode: Type.Number(), error: optional(Type.String()), interrupted: optional(Type.Boolean()),
	timedOut: optional(Type.Boolean()), stopped: optional(Type.Boolean()), detached: optional(Type.Boolean()),
}, { additionalProperties: false });
const ReviewSchema = Type.Object({
	status: Type.Union([Type.Literal("not-requested"), Type.Literal("review-required"), Type.Literal("reviewed"), Type.Literal("blockers")]),
	findings: optional(Type.Array(ReviewFindingSchema)),
}, { additionalProperties: false });
const EffectsSchema = Type.Object({
	fileMutation: optional(Type.Object({
		status: Type.Union([Type.Literal("not-requested"), Type.Literal("not-applicable"), Type.Literal("observed"), Type.Literal("missing")]),
		expected: Type.Boolean(), attempted: Type.Boolean(), message: optional(Type.String()),
	}, { additionalProperties: false })),
}, { additionalProperties: false });
const ChainOutputsSchema = Type.Record(Type.String(), Type.Object({
	text: Type.String(), structured: optional(Type.Unknown()), agent: Type.String(), stepIndex: Type.Number(),
}, { additionalProperties: false }));

const WorkflowNodeSchema = Type.Cyclic({
	Node: Type.Object({
		id: Type.String(), kind: Type.Union([Type.Literal("step"), Type.Literal("parallel-group"), Type.Literal("dynamic-parallel-group"), Type.Literal("agent")]),
		agent: optional(Type.String()), phase: optional(Type.String()), label: Type.String(),
		status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("paused"), Type.Literal("stopped"), Type.Literal("detached")]),
		flatIndex: optional(Type.Number()), stepIndex: optional(Type.Number()), children: optional(Type.Array(Type.Ref("Node"))),
		dynamic: optional(Type.Object({
			sourceOutput: Type.String(), sourcePath: Type.String(), itemName: Type.String(), maxItems: optional(Type.Number()), collectAs: optional(Type.String()),
		}, { additionalProperties: false })),
		itemKey: optional(Type.String()), outputName: optional(Type.String()), structured: optional(Type.Boolean()),
		acceptanceStatus: optional(Type.Union([AcceptanceEvidenceStatus, Type.Literal("review-required"), Type.Literal("reviewed"), Type.Literal("accepted")])),
		error: optional(Type.String()),
	}, { additionalProperties: false }),
}, "Node");
const WorkflowGraphSchema = Type.Object({
	runId: Type.String(), mode: RunMode,
	phases: Type.Array(Type.Object({ title: Type.String(), nodeIds: StringArray }, { additionalProperties: false })),
	nodes: Type.Array(WorkflowNodeSchema), currentNodeId: optional(Type.String()),
}, { additionalProperties: false });

const NestedRunSummarySchema = Type.Cyclic({
	Run: Type.Object({
		id: Type.String(), parentRunId: Type.String(), parentStepIndex: optional(Type.Number()), parentAgent: optional(Type.String()), depth: Type.Number(),
		path: Type.Array(Type.Object({ runId: Type.String(), stepIndex: optional(Type.Number()), agent: optional(Type.String()) }, { additionalProperties: false })),
		asyncDir: optional(Type.String()), pid: optional(Type.Number()), sessionId: optional(Type.String()), sessionFile: optional(Type.String()),
		intercomTarget: optional(Type.String()), ownerIntercomTarget: optional(Type.String()), leafIntercomTarget: optional(Type.String()),
		ownerState: optional(Type.Union([Type.Literal("live"), Type.Literal("gone"), Type.Literal("unknown")])), controlInbox: optional(Type.String()), capabilityToken: optional(Type.String()),
		mode: optional(RunMode), processTerminal: optional(ProcessTerminalSchema), capabilityCeiling: optional(CapabilityCeilingSchema), capabilityAudit: optional(CapabilityAuditSchema),
		state: RunState, agent: optional(Type.String()), agents: optional(StringArray), currentStep: optional(Type.Number()), chainStepCount: optional(Type.Number()),
		parallelGroups: optional(Type.Array(ParallelGroupSchema)),
		steps: optional(Type.Array(Type.Object({
			agent: Type.String(), status: StepState, sessionFile: optional(Type.String()), transcriptPath: optional(Type.String()), transcriptError: optional(Type.String()),
			activityState: optional(ActivityState), lastActivityAt: optional(Type.Number()), currentTool: optional(Type.String()), currentToolStartedAt: optional(Type.Number()), currentPath: optional(Type.String()),
			turnCount: optional(Type.Number()), toolCount: optional(Type.Number()), startedAt: optional(Type.Number()), endedAt: optional(Type.Number()), error: optional(Type.String()),
			watchdog: optional(ChildWatchdogSchema), timedOut: optional(Type.Boolean()), stopped: optional(Type.Boolean()), turnBudget: optional(TurnBudgetSchema),
			turnBudgetExceeded: optional(Type.Boolean()), wrapUpRequested: optional(Type.Boolean()), toolBudget: optional(ToolBudgetSchema), toolBudgetBlocked: optional(Type.Boolean()),
			processTerminal: optional(ProcessTerminalSchema), capabilityCeiling: optional(CapabilityCeilingSchema), capabilityAudit: optional(CapabilityAuditSchema),
			children: optional(Type.Array(Type.Ref("Run"))),
		}, { additionalProperties: true }))),
		children: optional(Type.Array(Type.Ref("Run"))), activityState: optional(ActivityState), lastActivityAt: optional(Type.Number()),
		currentTool: optional(Type.String()), currentToolStartedAt: optional(Type.Number()), currentPath: optional(Type.String()), turnCount: optional(Type.Number()), toolCount: optional(Type.Number()),
		totalTokens: optional(TokenUsageSchema), totalCost: optional(CostSummarySchema), startedAt: optional(Type.Number()), endedAt: optional(Type.Number()), lastUpdate: optional(Type.Number()),
		timeoutMs: optional(Type.Number()), deadlineAt: optional(Type.Number()), timedOut: optional(Type.Boolean()), stopped: optional(Type.Boolean()), turnBudget: optional(TurnBudgetSchema),
		turnBudgetExceeded: optional(Type.Boolean()), wrapUpRequested: optional(Type.Boolean()), toolBudget: optional(ToolBudgetSchema), toolBudgetBlocked: optional(Type.Boolean()), error: optional(Type.String()),
	}, { additionalProperties: true }),
}, "Run");

export const AsyncStatusStepSchema = Type.Object({
	agent: Type.String(), status: StepState, context: optional(ContextMode), phase: optional(Type.String()), label: optional(Type.String()),
	outputName: optional(Type.String()), structured: optional(Type.Boolean()), children: optional(Type.Array(NestedRunSummarySchema)),
	sessionFile: optional(Type.String()), transcriptPath: optional(Type.String()), transcriptError: optional(Type.String()),
	activityState: optional(ActivityState), lastActivityAt: optional(Type.Number()), currentTool: optional(Type.String()), currentToolArgs: optional(Type.String()),
	currentToolStartedAt: optional(Type.Number()), currentPath: optional(Type.String()),
	recentTools: optional(Type.Array(Type.Object({ tool: Type.String(), args: Type.String(), endMs: Type.Number() }, { additionalProperties: false }))),
	recentOutput: optional(StringArray), turnCount: optional(Type.Number()), toolCount: optional(Type.Number()), startedAt: optional(Type.Number()), endedAt: optional(Type.Number()),
	durationMs: optional(Type.Number()), exitCode: optional(Type.Union([Type.Number(), Type.Null()])), timedOut: optional(Type.Boolean()), stopped: optional(Type.Boolean()),
	turnBudget: optional(TurnBudgetSchema), turnBudgetExceeded: optional(Type.Boolean()), wrapUpRequested: optional(Type.Boolean()),
	toolBudget: optional(ToolBudgetSchema), toolBudgetBlocked: optional(Type.Boolean()), tokens: optional(TokenUsageSchema), skills: optional(StringArray),
	model: optional(Type.String()), thinking: optional(Type.String()), attemptedModels: optional(StringArray), modelAttempts: optional(Type.Array(ModelAttemptSchema)),
	totalCost: optional(CostSummarySchema), steering: optional(SteeringStatusSchema), error: optional(Type.String()), structuredOutput: optional(Type.Unknown()),
	structuredOutputPath: optional(Type.String()), structuredOutputSchemaPath: optional(Type.String()), acceptance: optional(AcceptanceLedgerSchema),
	agentContract: optional(AgentContractSchema), launchContractDigest: optional(Type.String()), execution: optional(ExecutionSchema), review: optional(ReviewSchema), effects: optional(EffectsSchema),
	watchdog: optional(ChildWatchdogSchema), processTerminal: optional(ProcessTerminalSchema), capabilityCeiling: optional(CapabilityCeilingSchema), capabilityAudit: optional(CapabilityAuditSchema),
}, { additionalProperties: true });

export const AsyncStatusSchema = Type.Object({
	lifecycleArtifactVersion: optional(Type.Literal(3)), runId: Type.String(), sessionId: optional(Type.String()), mode: RunMode, isNested: optional(Type.Boolean()), state: RunState,
	error: optional(Type.String()), activityState: optional(ActivityState), lastActivityAt: optional(Type.Number()), currentTool: optional(Type.String()), currentToolStartedAt: optional(Type.Number()),
	currentPath: optional(Type.String()), turnCount: optional(Type.Number()), toolCount: optional(Type.Number()), steering: optional(SteeringStatusSchema),
	startedAt: Type.Number(), endedAt: optional(Type.Number()), lastUpdate: optional(Type.Number()), timeoutMs: optional(Type.Number()), deadlineAt: optional(Type.Number()),
	timedOut: optional(Type.Boolean()), stopped: optional(Type.Boolean()), turnBudget: optional(TurnBudgetSchema), turnBudgetExceeded: optional(Type.Boolean()), wrapUpRequested: optional(Type.Boolean()),
	toolBudget: optional(ToolBudgetSchema), toolBudgetBlocked: optional(Type.Boolean()), pid: optional(Type.Number()), cwd: optional(Type.String()), currentStep: optional(Type.Number()),
	chainStepCount: optional(Type.Number()), pendingAppends: optional(Type.Number()), parallelGroups: optional(Type.Array(ParallelGroupSchema)), workflowGraph: optional(WorkflowGraphSchema),
	processTerminal: optional(ProcessTerminalSchema), launchContractDigest: optional(Type.String()), capabilityCeiling: optional(CapabilityCeilingSchema), capabilityAudit: optional(CapabilityAuditSchema),
	steps: optional(Type.Array(AsyncStatusStepSchema)), sessionDir: optional(Type.String()), outputFile: optional(Type.String()), totalTokens: optional(TokenUsageSchema),
	totalCost: optional(CostSummarySchema), sessionFile: optional(Type.String()), outputs: optional(ChainOutputsSchema), parallelHandoff: optional(ParallelHandoffSchema),
}, { additionalProperties: true });

export function decodeAsyncStatus(value: unknown, source: string): AsyncStatus {
	if (Value.Check(AsyncStatusSchema, value)) return value;
	const [first] = Value.Errors(AsyncStatusSchema, value);
	const detail = first ? `${first.instancePath || "/"}: ${first.message}` : "invalid structure";
	throw new Error(`Invalid async status '${source}': ${detail}.`);
}
