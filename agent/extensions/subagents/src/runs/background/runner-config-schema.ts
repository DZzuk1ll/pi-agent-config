import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
	ArtifactConfig,
	MaxOutputConfig,
	NestedRouteInfo,
	ResolvedControlConfig,
	ResolvedToolBudget,
	ResolvedTurnBudget,
	SubagentRunMode,
	WorkflowGraphSnapshot,
} from "../../shared/types.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { isDynamicRunnerGroup, isParallelGroup, type RunnerStep } from "../shared/parallel-utils.ts";
import type { SessionLeaseRequest } from "../shared/session-lease.ts";
import { validateAcceptanceInput } from "../shared/acceptance.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { resolveTurnBudgetConfig } from "../shared/turn-budget.ts";

export interface SubagentRunConfig {
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string | null;
	piPackageRoot?: string;
	piArgv1?: string;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	revivalLease?: SessionLeaseRequest;
	revivalLeaseToken?: string;
	globalConcurrencyLimit?: number;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	launchContractDigest?: string;
	runnerProcessInstanceId?: string;
}

const optional = Type.Optional;
const StringArray = Type.Array(Type.String());
const JsonObject = Type.Record(Type.String(), Type.Unknown());
const NullableString = Type.Union([Type.String(), Type.Null()]);
const NonNegativeInteger = Type.Integer({ minimum: 0 });
const PositiveInteger = Type.Integer({ minimum: 1 });
const PositiveNumber = Type.Number({ exclusiveMinimum: 0 });

const AgentContractSchema = Type.Object({ version: Type.Literal(1) }, { additionalProperties: false });
const TurnBudgetSchema = Type.Object({
	maxTurns: PositiveInteger,
	graceTurns: NonNegativeInteger,
}, { additionalProperties: false });
const ToolBudgetSchema = Type.Object({
	soft: optional(PositiveInteger),
	hard: PositiveInteger,
	block: Type.Union([Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), Type.Literal("*")]),
}, { additionalProperties: false });
const CapabilityCeilingSchema = Type.Object({
	version: Type.Literal(1),
	allowedTools: optional(StringArray),
	denyExtensions: Type.Boolean(),
	sources: StringArray,
}, { additionalProperties: false });
const CapabilityAuditSchema = Type.Object({
	ceiling: CapabilityCeilingSchema,
	requestedTools: optional(StringArray),
	effectiveTools: StringArray,
	removedTools: StringArray,
	internalTools: StringArray,
	extensionsDenied: Type.Boolean(),
	removedExtensionCount: NonNegativeInteger,
	requestedMcpToolCount: NonNegativeInteger,
	effectiveMcpTools: StringArray,
}, { additionalProperties: false });

const AcceptanceEvidenceKind = Type.Union([
	Type.Literal("changed-files"), Type.Literal("tests-added"), Type.Literal("commands-run"), Type.Literal("validation-output"),
	Type.Literal("residual-risks"), Type.Literal("no-staged-files"), Type.Literal("diff-summary"), Type.Literal("review-findings"), Type.Literal("manual-notes"),
]);
const AcceptanceGateSchema = Type.Object({
	id: Type.String({ minLength: 1 }), must: Type.String({ minLength: 1 }), evidence: optional(Type.Array(AcceptanceEvidenceKind)),
	severity: optional(Type.Union([Type.Literal("required"), Type.Literal("recommended")])),
}, { additionalProperties: false });
const AcceptanceVerifyCommandSchema = Type.Object({
	id: Type.String({ minLength: 1 }), command: Type.String({ minLength: 1 }), timeoutMs: optional(PositiveInteger), cwd: optional(Type.String({ minLength: 1 })),
	env: optional(Type.Record(Type.String(), Type.String())), allowFailure: optional(Type.Boolean()),
}, { additionalProperties: false });
const AcceptanceReviewSchema = Type.Object({
	agent: optional(Type.String()), focus: optional(Type.String()), required: optional(Type.Boolean()),
}, { additionalProperties: false });
const AcceptanceConfigSchema = Type.Object({
	level: optional(Type.Union([Type.Literal("auto"), Type.Literal("none"), Type.Literal("attested"), Type.Literal("checked"), Type.Literal("verified")])),
	criteria: optional(Type.Array(Type.Union([Type.String(), AcceptanceGateSchema]))), evidence: optional(Type.Array(AcceptanceEvidenceKind)),
	verify: optional(Type.Array(AcceptanceVerifyCommandSchema)), review: optional(Type.Union([AcceptanceReviewSchema, Type.Literal(false)])),
	stopRules: optional(StringArray), reason: optional(Type.String()),
}, { additionalProperties: false });
const AcceptanceInputSchema = Type.Union([
	Type.Literal("auto"), Type.Literal("attested"), Type.Literal("checked"), Type.Literal("verified"), Type.Literal(false), AcceptanceConfigSchema,
]);
const ResolvedAcceptanceGateSchema = Type.Object({
	id: Type.String(), must: Type.String(), evidence: Type.Array(AcceptanceEvidenceKind),
	severity: Type.Union([Type.Literal("required"), Type.Literal("recommended")]),
}, { additionalProperties: false });
const ResolvedAcceptanceSchema = Type.Object({
	level: Type.Union([Type.Literal("none"), Type.Literal("attested"), Type.Literal("checked"), Type.Literal("verified")]),
	explicit: Type.Boolean(), inferredReason: StringArray, criteria: Type.Array(ResolvedAcceptanceGateSchema), evidence: Type.Array(AcceptanceEvidenceKind),
	verify: Type.Array(AcceptanceVerifyCommandSchema), review: optional(Type.Union([AcceptanceReviewSchema, Type.Literal(false)])),
	stopRules: StringArray, reason: optional(Type.String()),
}, { additionalProperties: false });

const StructuredOutputSchema = Type.Object({
	schema: JsonObject,
	schemaPath: Type.String(),
	outputPath: Type.String(),
}, { additionalProperties: false });
const ImportedRootSchema = Type.Object({
	runId: Type.String(), asyncDir: Type.String(), resultPath: Type.String(), index: NonNegativeInteger,
}, { additionalProperties: false });

const RunnerSubagentStepSchema = Type.Object({
	parentSessionId: optional(Type.String()),
	agent: Type.String(),
	task: Type.String(),
	context: optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
	importAsyncRoot: optional(ImportedRootSchema),
	phase: optional(Type.String()), label: optional(Type.String()), outputName: optional(Type.String()), structured: optional(Type.Boolean()),
	cwd: optional(Type.String()), model: optional(Type.String()), thinking: optional(Type.String()), modelCandidates: optional(StringArray),
	tools: optional(StringArray), extensions: optional(StringArray), subagentOnlyExtensions: optional(StringArray), mcpDirectTools: optional(StringArray),
	completionGuard: optional(Type.Boolean()), systemPrompt: optional(Type.Union([Type.String(), Type.Null()])),
	systemPromptMode: optional(Type.Union([Type.Literal("append"), Type.Literal("replace")])),
	inheritProjectContext: Type.Boolean(), inheritSkills: Type.Boolean(), skills: optional(StringArray), outputPath: optional(Type.String()),
	namespaceOutputPath: optional(Type.Boolean()), outputMode: optional(Type.Union([Type.Literal("inline"), Type.Literal("file-only")])),
	sessionFile: optional(Type.String()), maxSubagentDepth: optional(NonNegativeInteger), waitToolEnabled: optional(Type.Boolean()),
	structuredOutput: optional(StructuredOutputSchema), structuredOutputSchema: optional(JsonObject), agentContract: optional(AgentContractSchema),
	definitionDigest: optional(Type.String()), launchBindingTask: optional(Type.String()), launchContractDigest: optional(Type.String()),
	effectiveAcceptance: optional(ResolvedAcceptanceSchema), acceptanceInput: optional(AcceptanceInputSchema),
	acceptanceRole: optional(Type.Union([Type.Literal("read-only"), Type.Literal("writer")])),
	gateOn: optional(Type.Union([Type.Literal("execution"), Type.Literal("acceptance")])),
	toolBudget: optional(ToolBudgetSchema), capabilityCeiling: optional(CapabilityCeilingSchema), capabilityAudit: optional(CapabilityAuditSchema),
}, { additionalProperties: false });

const DynamicExpandSchema = Type.Object({
	from: Type.Object({ output: Type.String(), path: Type.String() }, { additionalProperties: false }),
	item: optional(Type.String()), key: optional(Type.String()), maxItems: optional(NonNegativeInteger),
	onEmpty: optional(Type.Union([Type.Literal("skip"), Type.Literal("fail")])),
}, { additionalProperties: false });
const DynamicCollectSchema = Type.Object({ as: Type.String(), outputSchema: optional(JsonObject) }, { additionalProperties: false });
const ParallelGroupSchema = Type.Object({
	parallel: Type.Array(RunnerSubagentStepSchema, { minItems: 1 }), concurrency: optional(PositiveInteger), failFast: optional(Type.Boolean()), worktree: optional(Type.Boolean()),
}, { additionalProperties: false });
const DynamicGroupSchema = Type.Object({
	expand: DynamicExpandSchema, parallel: RunnerSubagentStepSchema, collect: DynamicCollectSchema,
	concurrency: optional(PositiveInteger), failFast: optional(Type.Boolean()), phase: optional(Type.String()), label: optional(Type.String()),
	sessionFiles: optional(Type.Array(NullableString)),
	thinkingOverrides: optional(Type.Array(Type.Union([Type.String(), Type.Literal(false), Type.Null()]))),
	effectiveAcceptance: optional(ResolvedAcceptanceSchema), acceptanceInput: optional(AcceptanceInputSchema),
	acceptanceRole: optional(Type.Union([Type.Literal("read-only"), Type.Literal("writer")])), agentContract: optional(AgentContractSchema),
	gateOn: optional(Type.Union([Type.Literal("execution"), Type.Literal("acceptance")])),
}, { additionalProperties: false });
const RunnerStepSchema = Type.Union([RunnerSubagentStepSchema, ParallelGroupSchema, DynamicGroupSchema]);

const WorkflowNodeSchema = Type.Cyclic({
	Node: Type.Object({
		id: Type.String(), kind: Type.Union([Type.Literal("step"), Type.Literal("parallel-group"), Type.Literal("dynamic-parallel-group"), Type.Literal("agent")]),
		agent: optional(Type.String()), phase: optional(Type.String()), label: Type.String(),
		status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("paused"), Type.Literal("stopped"), Type.Literal("detached")]),
		flatIndex: optional(NonNegativeInteger), stepIndex: optional(NonNegativeInteger), children: optional(Type.Array(Type.Ref("Node"))),
		dynamic: optional(Type.Object({
			sourceOutput: Type.String(), sourcePath: Type.String(), itemName: Type.String(), maxItems: optional(NonNegativeInteger), collectAs: optional(Type.String()),
		}, { additionalProperties: false })),
		itemKey: optional(Type.String()), outputName: optional(Type.String()), structured: optional(Type.Boolean()),
		acceptanceStatus: optional(Type.Union([
			Type.Literal("pending"), Type.Literal("not-required"), Type.Literal("claimed"), Type.Literal("attested"), Type.Literal("checked"),
			Type.Literal("verified"), Type.Literal("rejected"), Type.Literal("review-required"), Type.Literal("reviewed"), Type.Literal("accepted"),
		])),
		error: optional(Type.String()),
	}, { additionalProperties: false }),
}, "Node");
const WorkflowGraphSchema = Type.Object({
	runId: Type.String(), mode: Type.Union([Type.Literal("single"), Type.Literal("parallel"), Type.Literal("chain")]),
	phases: Type.Array(Type.Object({ title: Type.String(), nodeIds: StringArray }, { additionalProperties: false })),
	nodes: Type.Array(WorkflowNodeSchema), currentNodeId: optional(Type.String()),
}, { additionalProperties: false });

const ArtifactConfigSchema = Type.Partial(Type.Object({
	enabled: Type.Boolean(), dir: Type.Union([Type.Literal("project"), Type.Literal("session"), Type.Literal("temp")]),
	includeInput: Type.Boolean(), includeOutput: Type.Boolean(), includeJsonl: Type.Boolean(), includeTranscript: Type.Boolean(),
	includeMetadata: Type.Boolean(), cleanupDays: NonNegativeInteger,
}, { additionalProperties: false }));
const ControlConfigSchema = Type.Object({
	enabled: Type.Boolean(), needsAttentionAfterMs: PositiveInteger, activeNoticeAfterMs: PositiveInteger,
	activeNoticeAfterTurns: optional(PositiveInteger), activeNoticeAfterTokens: optional(PositiveInteger), failedToolAttemptsBeforeAttention: PositiveInteger,
	notifyOn: Type.Array(Type.Union([Type.Literal("active_long_running"), Type.Literal("needs_attention")])),
	notifyChannels: Type.Array(Type.Union([Type.Literal("event"), Type.Literal("async"), Type.Literal("intercom")])),
}, { additionalProperties: false });
const NestedRouteSchema = Type.Object({
	rootRunId: Type.String(), eventSink: Type.String(), controlInbox: Type.String(), capabilityToken: Type.String(),
}, { additionalProperties: false });
const NestedPathPartSchema = Type.Object({
	runId: Type.String(), stepIndex: optional(NonNegativeInteger), agent: optional(Type.String()),
}, { additionalProperties: false });
const NestedSelfSchema = Type.Object({
	parentRunId: Type.String(), parentStepIndex: optional(NonNegativeInteger), depth: NonNegativeInteger, path: optional(Type.Array(NestedPathPartSchema)),
}, { additionalProperties: false });
const RevivalLeaseSchema = Type.Object({
	sessionFile: Type.String(), runId: Type.String(), sourceRunId: Type.String(), parentSessionId: optional(Type.String()),
}, { additionalProperties: false });

const SubagentRunConfigSchema = Type.Object({
	id: Type.String({ minLength: 1 }), steps: Type.Array(RunnerStepSchema, { minItems: 1 }), resultPath: Type.String({ minLength: 1 }),
	cwd: Type.String({ minLength: 1 }), placeholder: Type.String({ minLength: 1 }), taskIndex: optional(NonNegativeInteger), totalTasks: optional(PositiveInteger),
	maxOutput: optional(Type.Object({ bytes: optional(PositiveInteger), lines: optional(PositiveInteger) }, { additionalProperties: false })),
	artifactsDir: optional(Type.String()), artifactConfig: optional(ArtifactConfigSchema), share: optional(Type.Boolean()), sessionDir: optional(Type.String()),
	asyncDir: Type.String({ minLength: 1 }), sessionId: optional(Type.Union([Type.String(), Type.Null()])), piPackageRoot: optional(Type.String()),
	piArgv1: optional(Type.String()), worktreeSetupHook: optional(Type.String()), worktreeSetupHookTimeoutMs: optional(PositiveInteger), worktreeBaseDir: optional(Type.String()),
	controlConfig: optional(ControlConfigSchema), controlIntercomTarget: optional(Type.String()), childIntercomTargets: optional(Type.Array(NullableString)),
	resultMode: optional(Type.Union([Type.Literal("single"), Type.Literal("parallel"), Type.Literal("chain")])), dynamicFanoutMaxItems: optional(NonNegativeInteger),
	workflowGraph: optional(WorkflowGraphSchema), nestedRoute: optional(NestedRouteSchema), nestedSelf: optional(NestedSelfSchema),
	timeoutMs: optional(PositiveNumber), deadlineAt: optional(PositiveNumber), turnBudget: optional(TurnBudgetSchema), toolBudget: optional(ToolBudgetSchema),
	revivalLease: optional(RevivalLeaseSchema), revivalLeaseToken: optional(Type.String()), globalConcurrencyLimit: optional(PositiveInteger),
	capabilityCeiling: optional(CapabilityCeilingSchema), launchContractDigest: optional(Type.String()), runnerProcessInstanceId: optional(Type.String()),
}, { additionalProperties: false });

function normalizeRunnerStep(step: RunnerStep): RunnerStep {
	if (!("expand" in step)) return step;
	return {
		...step,
		...(step.sessionFiles ? { sessionFiles: step.sessionFiles.map((file) => file ?? undefined) } : {}),
		...(step.thinkingOverrides ? { thinkingOverrides: step.thinkingOverrides.map((thinking) => thinking ?? undefined) } : {}),
	};
}

function validateAcceptance(value: unknown, path: string): void {
	const errors = validateAcceptanceInput(value, path);
	if (errors.length > 0) throw new TypeError(errors.join(" "));
}

function validateStepSemantics(step: RunnerStep, path: string): void {
	if (isParallelGroup(step)) {
		for (const [index, child] of step.parallel.entries()) validateStepSemantics(child, `${path}.parallel[${index}]`);
		return;
	}
	if (step.acceptanceInput !== undefined) validateAcceptance(step.acceptanceInput, `${path}.acceptanceInput`);
	if (isDynamicRunnerGroup(step)) {
		validateStepSemantics(step.parallel, `${path}.parallel`);
		return;
	}
	if (step.toolBudget !== undefined) {
		const result = validateToolBudgetConfig(step.toolBudget, `${path}.toolBudget`);
		if (result.error) throw new TypeError(result.error);
	}
}

export function decodeSubagentRunConfig(value: unknown, source: string): SubagentRunConfig {
	if (!Value.Check(SubagentRunConfigSchema, value)) {
		const [first] = Value.Errors(SubagentRunConfigSchema, value);
		const detail = first ? `${first.instancePath || "/"}: ${first.message}` : "invalid structure";
		throw new TypeError(`Invalid subagent runner config '${source}': ${detail}.`);
	}
	const wire = value;
	if (wire.turnBudget !== undefined) {
		const result = resolveTurnBudgetConfig(wire.turnBudget, "runnerConfig.turnBudget");
		if (result.error) throw new TypeError(result.error);
	}
	if (wire.toolBudget !== undefined) {
		const result = validateToolBudgetConfig(wire.toolBudget, "runnerConfig.toolBudget");
		if (result.error) throw new TypeError(result.error);
	}
	for (const [index, step] of wire.steps.entries()) validateStepSemantics(step as RunnerStep, `runnerConfig.steps[${index}]`);
	return {
		...wire,
		steps: wire.steps.map((step) => normalizeRunnerStep(step as RunnerStep)),
		...(wire.childIntercomTargets ? { childIntercomTargets: wire.childIntercomTargets.map((target) => target ?? undefined) } : {}),
	} as SubagentRunConfig;
}
