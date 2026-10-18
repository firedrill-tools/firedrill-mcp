import { z } from "zod";
import { CompositePolicySchema } from "./composite.js";
import { PopulationPurposeSchema } from "./population-disclosure.js";
import { TargetExecutionPolicySchema } from "./target-execution.js";
import { TASK_METRIC_VERSION } from "./task-metrics.js";
export * from "./composite.js";
export * from "./population-disclosure.js";
export * from "./retained-values.js";
export * from "./batch-receipt.js";
export * from "./service-catalog.js";
export * from "./service-instances.js";
export * from "./run-interventions.js";
export * from "./discovery.js";
export * from "./dataset-policy.js";
export * from "./ci-context.js";
export * from "./activity-filters.js";
export * from "./target-execution.js";
export * from "./run-measurements.js";
export * from "./read-scope.js";
export * from "./task-metrics.js";
export * from "./result-lifecycle.js";
export * from "./batch-overview.js";
export * from "./service-resources.js";
export * from "./capacity.js";
export * from "./recommendations.js";

export const CONTRACT_VERSION = "2026-10-14" as const;
export * from "./comparisons.js";
export * from "./credentials.js";
export * from "./validation.js";
export * from "./inspection-filters.js";
export * from "./retention.js";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(JsonSchema), z.record(z.string(), JsonSchema),
]));
const Id = z.string().min(1).max(160);
export const ScopeSchema = z.object({ projectId: Id, environmentId: Id }).strict();
export type Scope = z.infer<typeof ScopeSchema>;
export const TARGET_METADATA_VERSION = "2026-10-15-target-metadata.1" as const;
export const TARGET_RESET_AREAS = ["applicationDatabase", "cache", "filesystem", "conversationMemory", "outstandingJobs", "browserProfile", "externalState"] as const;
const ResetCoverageStateSchema = z.enum(["customer_managed", "not_reset", "not_used", "unknown"]);
/** Retained caller declarations, not permissions, automatic reset hooks or verified execution facts. */
export const TargetMetadataSchema = z.object({
  schemaVersion: z.literal(TARGET_METADATA_VERSION),
  source: z.object({
    revision: z.string().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value), "Use a source revision without control characters; never include credentials."),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    dirty: z.enum(["clean", "dirty", "unknown"]).default("unknown"),
  }).strict().optional(),
  resetCoverage: z.object({
    applicationDatabase: ResetCoverageStateSchema.optional(), cache: ResetCoverageStateSchema.optional(),
    filesystem: ResetCoverageStateSchema.optional(), conversationMemory: ResetCoverageStateSchema.optional(),
    outstandingJobs: ResetCoverageStateSchema.optional(), browserProfile: ResetCoverageStateSchema.optional(),
    externalState: ResetCoverageStateSchema.optional(),
  }).strict().optional(),
}).strict();
export type TargetMetadata = z.infer<typeof TargetMetadataSchema>;
const TargetMetadataFields = { metadata: TargetMetadataSchema.optional() };
export const CommandTargetSchema = z.object({
  ...TargetMetadataFields,
  kind: z.literal("command"), argv: z.array(z.string().max(8192)).min(1).max(128),
  cwd: z.string().max(4096).optional(),
}).strict();
export const HttpTargetSchema = z.object({
  ...TargetMetadataFields,
  kind: z.literal("http"), url: z.string().url(),
  method: z.enum(["POST", "PUT"]).default("POST"),
}).strict();
const IsolatedSourcePath = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,159}$/).refine(value => !value.split("/").some(part => !part || part.startsWith(".")), "Use plain relative paths without hidden or traversal segments.");
export const IsolatedNodeTargetSchema = z.object({
  ...TargetMetadataFields,
  kind: z.literal("isolated_node"), entrypoint: IsolatedSourcePath.refine(value => /\.(?:js|mjs)$/.test(value), "Select a .js or .mjs entrypoint."), image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  files: z.array(z.object({ path: IsolatedSourcePath, bytes: z.number().int().min(1).max(2 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(64),
  approvedServices: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), url: z.string().url(),
    routes: z.array(z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().max(256).regex(/^\/[A-Za-z0-9/_-]*$/).refine(value => !value.includes("//"), "Use a plain exact path.") }).strict()).min(1).max(16),
    allowPrivateAddress: z.literal(true).optional(),
  }).strict().superRefine((service, ctx) => {
    const url = new URL(service.url);
    if (url.origin !== service.url || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !(service.allowPrivateAddress && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname)))
      ctx.addIssue({ code: "custom", path: ["url"], message: "Use an exact HTTPS origin; private HTTP requires explicit literal IPv4 acknowledgement. Runtime DNS/address checks still apply." });
  })).max(8).default([]),
}).strict();
export const TargetSchema = z.discriminatedUnion("kind", [CommandTargetSchema, HttpTargetSchema,
  z.object({ ...TargetMetadataFields, kind: z.literal("native"), name: z.string().min(1).max(200) }).strict(), IsolatedNodeTargetSchema]);
export type Target = z.infer<typeof TargetSchema>;
export interface TargetDisclosure {
  schemaVersion: typeof TARGET_METADATA_VERSION;
  source: { state: "selected_files_pinned" | "declared_revision" | "unknown";
    revision: string | null; contentDigest: string | null; dirty: "clean" | "dirty" | "unknown";
    verification: "required_at_isolated_execution" | "not_verified" };
  resetCoverage: Record<typeof TARGET_RESET_AREAS[number], z.infer<typeof ResetCoverageStateSchema>>;
  automaticTargetReset: false;
  replay: "reexecution_not_identical_output";
}
/** Missing metadata stays unknown, including on historical recipes; names/URLs are not source versions. */
export function targetDisclosure(target: Target): TargetDisclosure {
  const source = target.metadata?.source;
  return {
    schemaVersion: TARGET_METADATA_VERSION,
    source: { state: target.kind === "isolated_node" ? "selected_files_pinned" : source ? "declared_revision" : "unknown",
      revision: source?.revision ?? null, contentDigest: source?.contentDigest ?? null, dirty: source?.dirty ?? "unknown",
      verification: target.kind === "isolated_node" ? "required_at_isolated_execution" : "not_verified" },
    resetCoverage: Object.fromEntries(TARGET_RESET_AREAS.map(area => [area, target.metadata?.resetCoverage?.[area] ?? "unknown"])) as TargetDisclosure["resetCoverage"],
    automaticTargetReset: false, replay: "reexecution_not_identical_output",
  };
}
export const EFFECT_CHECK_VERSION = "2026-10-15-effect-check.1" as const;
const EvidencePointerSchema = z.string().max(1000).refine(
  value => (value === "" || value.startsWith("/")) && !/~(?![01])/.test(value),
  "Use a JSON pointer with ~0/~1 escaping, or the empty pointer.",
);
function comparatorIssues(value: { comparator: string; expected?: Json }, ctx: z.RefinementCtx, path: Array<string | number> = []) {
  if (value.comparator === "exists" && value.expected !== undefined && typeof value.expected !== "boolean")
    ctx.addIssue({ code: "custom", path: [...path, "expected"], message: "The exists comparator accepts only a boolean expected value; omit it to require presence." });
  if (["lte", "gte"].includes(value.comparator) && (typeof value.expected !== "number" || !Number.isFinite(value.expected)))
    ctx.addIssue({ code: "custom", path: [...path, "expected"], message: "The lte/gte comparator requires an explicit finite numeric expected value." });
}
const EffectSourceBase = { schemaVersion: z.literal(EFFECT_CHECK_VERSION), service: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) };
export const EffectSourceSchema = z.discriminatedUnion("kind", [
  z.object({ ...EffectSourceBase, kind: z.literal("service_state"), namespace: Id, rowId: z.string().min(1).max(512) }).strict(),
  z.object({ ...EffectSourceBase, kind: z.literal("service_activity"), where: z.object({ path: EvidencePointerSchema, equals: JsonSchema }).strict().optional() }).strict(),
  z.object({ ...EffectSourceBase, kind: z.literal("service_pending") }).strict(),
]);
/** A finite scalar from frozen evidence, not a formula, evaluator score or assertion. */
export const TaskMetricDefinitionSchema = z.object({
  schemaVersion: z.literal(TASK_METRIC_VERSION), id: Id, label: z.string().min(1).max(200),
  path: EvidencePointerSchema,
  unit: z.string().trim().min(1).max(64).refine(value => !/[\x00-\x1f\x7f]/.test(value), "Use a printable unit label; no unit conversion is inferred."),
  direction: z.enum(["higher_is_better", "lower_is_better", "neutral"]).optional(),
  source: EffectSourceSchema.optional(),
}).strict();
export type TaskMetricDefinition = z.infer<typeof TaskMetricDefinitionSchema>;
export const NUMERIC_CHECK_VERSION = "2026-10-16-numeric-check.1" as const;
/** Declared measurement units, not automatic conversion or inferred accuracy. */
export const NumericCheckSchema = z.object({
  schemaVersion: z.literal(NUMERIC_CHECK_VERSION),
  unit: z.string().trim().min(1).max(64).refine(value => !/[\x00-\x1f\x7f]/.test(value), "Use a printable unit label."),
  absoluteTolerance: z.number().finite().min(0).default(0),
}).strict();
export type NumericCheck = z.output<typeof NumericCheckSchema>;
export const ExactCheckSchema = z.object({
  id: Id, description: z.string().min(1).max(2000),
  path: EvidencePointerSchema, comparator: z.enum(["equals", "contains", "exists", "lte", "gte"]),
  expected: JsonSchema.optional(), required: z.boolean().default(true),
  /** Omitted retains runner input/output/metrics selectors. Service selectors use closure-attested facts only. */
  source: EffectSourceSchema.optional(),
  numeric: NumericCheckSchema.optional(),
}).strict().superRefine((value, ctx) => {
  comparatorIssues(value, ctx);
  if (value.numeric && (!["equals", "lte", "gte"].includes(value.comparator) || typeof value.expected !== "number"))
    ctx.addIssue({ code: "custom", path: ["numeric"], message: "Numeric policy requires equals/lte/gte and an explicit finite numeric expected value. Units are declared, not converted." });
});
export const ASSESSMENT_POLICY_VERSION = "2026-10-15-assessment.1" as const;
export const RubricSchema = z.object({
  composite: CompositePolicySchema.optional(),
  id: Id, version: Id, policyVersion: z.literal(ASSESSMENT_POLICY_VERSION).optional(), dimensions: z.array(z.object({
    id: Id, description: z.string().min(1).max(4000),
    anchors: z.tuple([z.string().min(1).max(4000), z.string().min(1).max(4000), z.string().min(1).max(4000), z.string().min(1).max(4000), z.string().min(1).max(4000)]),
    /** Omitted means text observations. Unsupported required modalities stay unknown. */
    evidenceKinds: z.array(z.enum(["text", "image", "audio", "video"])).min(1).max(4).optional(),
    /** Frozen by the scenario author, never inferred by an evaluator. Omitted means applicable. */
    applicability: z.discriminatedUnion("state", [
      z.object({ state: z.literal("applicable") }).strict(),
      z.object({ state: z.literal("not_applicable"), reason: z.string().min(1).max(2000) }).strict(),
    ]).optional(),
    /** Missing evidence never becomes a zero, pass or automatic exemption. */
    missingEvidence: z.literal("not_assessable").optional(),
  }).strict()).min(1).max(12),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.dimensions.map(item => item.id)).size !== value.dimensions.length) ctx.addIssue({ code: "custom", path: ["dimensions"], message: "Dimension IDs must be unique." });
  if (!value.policyVersion && value.dimensions.some(item => item.applicability || item.missingEvidence)) ctx.addIssue({ code: "custom", path: ["policyVersion"], message: `Declare ${ASSESSMENT_POLICY_VERSION} when using explicit applicability or missing-evidence policy.` });
  if (value.composite) for (const [index, item] of value.composite.weights.entries()) {
    if (!value.dimensions.some(dimension => dimension.id === item.dimensionId)) ctx.addIssue({ code: "custom", path: ["composite", "weights", index, "dimensionId"], message: "A composite may select only dimensions declared in this same rubric." });
  }
});
export const ReassessmentSchema = ScopeSchema.extend({ rubric: RubricSchema.optional() }).strict();
/** Optional scenario-controller operations are never target-agent grants. */
export const SERVICE_CONTROL_VERSION = "2026-10-15-service-control.1" as const;
export const SERVICE_CONTROL_CLOCK_VERSION = "2026-10-15-service-control.2" as const;
export const ServiceBindingSchema = z.object({
  alias: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), buildId: Id,
  datasetId: Id.optional(), seed: z.string().regex(/^(0|[1-9][0-9]*)$/).max(80),
  operations: z.array(Id).min(1).max(256),
  control: z.discriminatedUnion("schemaVersion", [
    z.object({ schemaVersion: z.literal(SERVICE_CONTROL_VERSION), operations: z.array(Id).min(1).max(256) }).strict(),
    z.object({ schemaVersion: z.literal(SERVICE_CONTROL_CLOCK_VERSION), operations: z.array(Id).max(256),
      clock: z.object({ advance: z.literal(true) }).strict().optional() }).strict(),
  ]).optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.operations).size !== value.operations.length) ctx.addIssue({ code: "custom", path: ["operations"], message: "Service operations must be distinct." });
  if (value.control && (new Set(value.control.operations).size !== value.control.operations.length || value.control.operations.some(operation => value.operations.includes(operation))))
    ctx.addIssue({ code: "custom", path: ["control", "operations"], message: "Scenario-control operations must be distinct and separate from target operations." });
  if (value.control?.schemaVersion === SERVICE_CONTROL_CLOCK_VERSION && !value.control.operations.length && !value.control.clock)
    ctx.addIssue({ code: "custom", path: ["control"], message: "Declare at least one operation or explicit clock.advance permission. Operation grants never imply clock authority." });
});
export type ServiceBinding = z.infer<typeof ServiceBindingSchema>;
export const SEQUENCE_VERSION = "2026-10-14-sequence.1" as const;
export const PredicateSchema = z.object({
  path: EvidencePointerSchema,
  comparator: z.enum(["equals", "contains", "exists", "lte", "gte"]), expected: JsonSchema.optional(),
}).strict();
const StepBase = { id: Id, when: PredicateSchema.extend({ step: Id }).optional() };
const ServiceAlias = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const SequenceStepSchema = z.discriminatedUnion("kind", [
  z.object({ ...StepBase, kind: z.literal("target"), input: JsonSchema.optional() }).strict(),
  z.object({ ...StepBase, kind: z.literal("service"), service: ServiceAlias, operationId: Id, arguments: z.record(z.string(), JsonSchema) }).strict(),
  z.object({ ...StepBase, kind: z.literal("wait_for"), service: ServiceAlias, operationId: Id, arguments: z.record(z.string(), JsonSchema),
    until: PredicateSchema, maxAttempts: z.number().int().min(1).max(100000), intervalMs: z.number().int().min(100).max(60000) }).strict(),
  z.object({ ...StepBase, kind: z.literal("advance_time"), service: ServiceAlias, toUs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), maxEvents: z.number().int().min(1).max(1000).default(100) }).strict(),
  z.object({ ...StepBase, kind: z.literal("snapshot"), service: ServiceAlias }).strict(),
  z.object({ ...StepBase, kind: z.literal("restore"), service: ServiceAlias, snapshotStepId: Id, boundary: z.literal("service_only") }).strict(),
]);
export const SequenceSchema = z.object({ schemaVersion: z.literal(SEQUENCE_VERSION), steps: z.array(SequenceStepSchema).min(1).max(10000) }).strict().superRefine((sequence, ctx) => {
  const previous = new Map<string, z.infer<typeof SequenceStepSchema>>();
  for (const [index, step] of sequence.steps.entries()) {
    if (step.when) comparatorIssues(step.when, ctx, ["steps", index, "when"]);
    if (step.kind === "wait_for") comparatorIssues(step.until, ctx, ["steps", index, "until"]);
    if (previous.has(step.id)) ctx.addIssue({ code: "custom", path: ["steps", index, "id"], message: "Step IDs must be distinct." });
    if (step.when && !previous.has(step.when.step)) ctx.addIssue({ code: "custom", path: ["steps", index, "when"], message: "A condition may read only an earlier step." });
    if (step.kind === "restore") {
      const snapshot = previous.get(step.snapshotStepId);
      if (snapshot?.kind !== "snapshot" || snapshot.service !== step.service) ctx.addIssue({ code: "custom", path: ["steps", index, "snapshotStepId"], message: "Restore must name an earlier snapshot of the same service." });
    }
    previous.set(step.id, step);
  }
});
export type SequenceStep = z.infer<typeof SequenceStepSchema>;
export type Predicate = z.infer<typeof PredicateSchema>;
export const ScenarioSchema = z.object({
  id: Id, name: z.string().min(1).max(200), input: JsonSchema,
  description: z.string().max(4000).optional(),
  checks: z.array(ExactCheckSchema).max(100).default([]),
  rubric: RubricSchema.optional(),
  /** Absent stays absent when parsing historical recipes and their canonical digests. */
  metrics: z.array(TaskMetricDefinitionSchema).min(1).max(32).optional(),
  serviceDatasets: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), Id).optional(),
  sequence: SequenceSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.checks.map(item => item.id)).size !== value.checks.length) ctx.addIssue({ code: "custom", path: ["checks"], message: "Check IDs must be unique." });
  if (value.metrics && new Set(value.metrics.map(item => item.id)).size !== value.metrics.length) ctx.addIssue({ code: "custom", path: ["metrics"], message: "Metric IDs must be unique within a scenario." });
});
export const ConfigurationSchema = z.object({
  id: Id, parameters: z.record(z.string(), JsonSchema).default({}),
}).strict();
/** Target task input is separate from the retained controller/evaluator recipe. */
export const TARGET_INVOCATION_VERSION = "2026-10-17-target-invocation.1" as const;
export const TargetScenarioSchema = z.object({ id: Id }).strict();
export type TargetScenario = z.infer<typeof TargetScenarioSchema>;
export function targetScenario(scenario: { id: string }): TargetScenario {
  return TargetScenarioSchema.parse({ id: scenario.id });
}
/** Structural transport shape; Tool grants still require their normal authority checks. */
export const TargetInvocationSchema = z.object({
  schemaVersion: z.literal(TARGET_INVOCATION_VERSION),
  input: JsonSchema,
  scenario: TargetScenarioSchema,
  configuration: ConfigurationSchema,
  runId: Id, attemptId: Id,
  tools: z.record(z.string(), JsonSchema),
  step: z.object({ id: Id, ordinal: z.number().int().min(0).max(9999) }).strict().optional(),
}).strict();
export type TargetInvocation = z.infer<typeof TargetInvocationSchema>;
export const POPULATION_VERSION = "2026-10-15-population.1" as const;
export const PopulationProvenanceSchema = z.object({
  schemaVersion: z.literal(POPULATION_VERSION), method: z.enum(["matrix", "sample"]), seed: z.string().min(1).max(200),
  candidateCount: z.number().int().min(1).max(1_000_000_000), selectedIndices: z.array(z.number().int().min(0).max(999_999_999)).min(1),
  sourceRecipeDigest: z.string().regex(/^[a-f0-9]{64}$/), axesDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PopulationProvenance = z.infer<typeof PopulationProvenanceSchema>;
export const RecipeSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION), name: z.string().min(1).max(200),
  scenarios: z.array(ScenarioSchema).min(1),
  target: TargetSchema,
  /** Explicit caller acknowledgement, not target isolation or automatic reset. */
  targetExecution: TargetExecutionPolicySchema.optional(),
  /** Reproducible authoring metadata; never evidence that any target executed. */
  population: PopulationProvenanceSchema.optional(),
  /** Caller-declared selection basis, not proof of a representative or held-out population. */
  populationPurpose: PopulationPurposeSchema.optional(),
  services: z.array(ServiceBindingSchema).default([]),
  configurations: z.array(ConfigurationSchema).min(1).default([{ id: "default", parameters: {} }]),
  repetitions: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  concurrency: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  limits: z.object({
    timeoutMs: z.number().int().min(100).max(30 * 86400000).default(60000),
    /** Optional caller execution budget, never a product allowance. */
    maxRuns: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
    maxOutputBytes: z.number().int().min(1024).max(8388608).default(1048576),
  }).default({ timeoutMs: 60000, maxRuns: null, maxOutputBytes: 1048576 }),
  gate: z.object({
    requireCompleted: z.boolean().default(true),
    requireExactChecks: z.boolean().default(true),
    minimumLevels: z.record(z.string(), z.number().int().min(0).max(4)).default({}),
    /** Native fractional evaluator scores. Missing/unassessable scores are inconclusive, never silently rounded to levels. */
    minimumScores: z.record(z.string(), z.number().finite().min(0).max(4)).optional(),
  }).strict().optional(),
}).strict().superRefine((recipe, ctx) => {
  const count = recipe.scenarios.length * recipe.configurations.length * recipe.repetitions;
  if (!Number.isSafeInteger(count)) ctx.addIssue({ code: "custom", path: ["repetitions"], message: "Expanded run count exceeds exact integer representation. Split the population into independently named recipes." });
  if (recipe.population && (recipe.population.selectedIndices.length !== recipe.scenarios.length || new Set(recipe.population.selectedIndices).size !== recipe.scenarios.length || recipe.population.selectedIndices.some(index => index >= recipe.population!.candidateCount)))
    ctx.addIssue({ code: "custom", path: ["population"], message: "Population provenance must identify one distinct in-range candidate per materialized scenario." });
  if (recipe.target.kind === "isolated_node") {
    const target = recipe.target;
    if (recipe.limits.maxOutputBytes > 4 * 1024 * 1024) ctx.addIssue({ code: "custom", path: ["limits", "maxOutputBytes"], message: "An isolated invocation supports at most four MiB of combined output." });
    if (recipe.target.files.reduce((sum, file) => sum + file.bytes, 0) > 8 * 1024 * 1024) ctx.addIssue({ code: "custom", path: ["target", "files"], message: "Selected isolated source files exceed eight MiB." });
    if (new Set(target.files.map(file => file.path)).size !== target.files.length || !target.files.some(file => file.path === target.entrypoint)) ctx.addIssue({ code: "custom", path: ["target", "files"], message: "File paths must be distinct and include the declared entrypoint." });
    if (recipe.limits.timeoutMs > 120000 && recipe.scenarios.some(scenario => !scenario.sequence)) ctx.addIssue({ code: "custom", path: ["limits", "timeoutMs"], message: "A single isolated invocation is bounded to 120 seconds." });
  }
  if (recipe.limits.maxRuns !== null && count > recipe.limits.maxRuns) ctx.addIssue({ code: "custom", path: ["limits", "maxRuns"], message: "Expanded runs exceed the authorized maximum. Reduce cases/repetitions or explicitly increase maxRuns." });
  for (const [key, ids] of [["scenarios", recipe.scenarios.map(v => v.id)], ["configurations", recipe.configurations.map(v => v.id)]] as const) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [key], message: "IDs must be unique." });
  }
  const aliases = new Set(recipe.services.map(service => service.alias));
  if (aliases.size !== recipe.services.length) ctx.addIssue({ code: "custom", path: ["services"], message: "Service aliases must be unique; two aliases may still use the same build." });
  for (const [index, scenario] of recipe.scenarios.entries()) for (const [checkIndex, check] of scenario.checks.entries()) {
    if (check.source && !aliases.has(check.source.service)) ctx.addIssue({ code: "custom", path: ["scenarios", index, "checks", checkIndex, "source"], message: "An effect check must select a service alias declared by this recipe." });
  }
  for (const [index, scenario] of recipe.scenarios.entries()) for (const [metricIndex, metric] of (scenario.metrics ?? []).entries()) {
    if (metric.source && !aliases.has(metric.source.service)) ctx.addIssue({ code: "custom", path: ["scenarios", index, "metrics", metricIndex, "source"], message: "An attested metric must select a service alias declared by this recipe." });
  }
  for (const [index, scenario] of recipe.scenarios.entries()) for (const alias of Object.keys(scenario.serviceDatasets ?? {})) {
    if (!aliases.has(alias)) ctx.addIssue({ code: "custom", path: ["scenarios", index, "serviceDatasets", alias], message: "Dataset override must name a service alias in this recipe." });
  }
  for (const [index, scenario] of recipe.scenarios.entries()) for (const [stepIndex, step] of (scenario.sequence?.steps ?? []).entries()) {
    if (!("service" in step)) continue;
    const binding = recipe.services.find(item => item.alias === step.service);
    if (!binding || ("operationId" in step && !binding.operations.includes(step.operationId) && !(step.kind === "service" && binding.control?.operations.includes(step.operationId)))) ctx.addIssue({ code: "custom", path: ["scenarios", index, "sequence", "steps", stepIndex], message: "Step must use a declared service alias and allowed operation. Only an explicit service step may invoke a declared scenario-control operation." });
  }
});
export type Recipe = z.infer<typeof RecipeSchema>;
export type RecipeInput = z.input<typeof RecipeSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Configuration = z.infer<typeof ConfigurationSchema>;
export const PopulationMaterializeSchema = ScopeSchema.extend({
  schemaVersion: z.literal(POPULATION_VERSION), recipe: RecipeSchema,
  axes: z.array(z.object({ path: z.string().min(1).max(1000).startsWith("/"), values: z.array(JsonSchema).min(1) }).strict()).min(1),
  selection: z.discriminatedUnion("method", [
    z.object({ method: z.literal("matrix"), seed: z.string().min(1).max(200) }).strict(),
    z.object({ method: z.literal("sample"), seed: z.string().min(1).max(200), count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
  ]),
}).strict();
export type PopulationRequest = z.input<typeof PopulationMaterializeSchema>;
export interface PopulationMaterialization { schemaVersion: typeof POPULATION_VERSION; recipe: Recipe; provenance: z.infer<typeof PopulationProvenanceSchema> }
/** Additive preparation protocol. It neither admits execution nor reserves capacity. */
export const PREPARATION_VERSION = "2026-10-14-preparation.1" as const;
export const RecipePreviewSchema = ScopeSchema.extend({ schemaVersion: z.literal(PREPARATION_VERSION), recipe: RecipeSchema }).strict();
export const ScenarioSaveSchema = ScopeSchema.extend({
  schemaVersion: z.literal(PREPARATION_VERSION), scenario: ScenarioSchema,
  /** null creates a new scenario ID; an exact current revision permits an append. */
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type ScenarioSaveInput = z.input<typeof ScenarioSaveSchema>;
export interface SavedScenario {
  schemaVersion: typeof PREPARATION_VERSION; projectId: string; environmentId: string;
  id: string; revision: string; scenario: Scenario; createdAt: string;
}
export interface EvaluatorAdmissionPolicy {
  /** Null is an explicitly configured uncapped batch allowance, not unknown. */
  maxRequestsPerBatch: number | null;
  maxConcurrentRequests: number;
  maxInputBytes: number;
  /** Null when the configured provider does not expose an output-token control. */
  maxOutputTokens: number | null;
  maxAttemptsPerAssessment: number;
}
export interface RecipePreview {
  schemaVersion: typeof PREPARATION_VERSION; projectId: string; environmentId: string;
  checkedAt: string; recipeDigest: string;
  /** Versioned policy disclosure before admission; does not activate a policy. */
  retention?: import("./retention.js").RetentionPolicyDisclosure;
  /** Optional for older service compatibility; absence is not a selection-purpose claim. */
  populationDisclosure?: import("./population-disclosure.js").PopulationDisclosure;
  scenarios: { id: string; revision: string }[];
  expansion: { scenarios: number; configurations: number; repetitions: number; runs: number; maximumTargetInvocations: number };
  target: { kind: Target["kind"]; executionOwner: "customer"; isolation: "customer_process" | "remote_application" | "customer_isolated_runner"; readiness: "not_checked"; probePerformed: false; disclosure: TargetDisclosure };
  targetExecution?: import("./target-execution.js").TargetExecutionDisclosure;
  services: { bindings: ServiceBinding[]; datasetOverrides: { scenarioId: string; datasets: Record<string, string> }[] };
  limits: { maxActiveRuns: number; pendingRunsPerOrganization: number | null; pendingRunsGlobal: number;
    recipeBytes: number; expandedBatchBytes: number; invocationTimeoutMs: number; maxOutputBytes: number; maxRuns: number | null };
  estimates: { expandedInputBytes: number; maximumConcurrentRuns: number; totalServiceInstances: number; maximumConcurrentServiceInstances: number };
  admission: { state: "currently_admissible" | "blocked"; reserved: false; canSubmit: boolean;
    organizationPendingRuns: number | null; scopePendingRuns: number; platformCapacityAvailable: boolean; blockers: { code: string; message: string; repair: string }[] };
  assessment: { requestedRuns: number; evaluatorConfigured: boolean; capacityReserved: false;
    /** Absent on older services; null means no evaluator is configured. */
    policy?: EvaluatorAdmissionPolicy | null };
  charge: { amount: 0; policy: "free_early_access"; customerInferenceAndRuntimeCost: "unknown_separate" };
  limitations: string[];
}
export type ExecutionState = "queued" | "running" | "completed" | "error" | "interrupted" | "cancelled";
export type AssessmentState = "not_requested" | "pending" | "completed" | "partial" | "unavailable" | "error";
export type GateState = "not_configured" | "allow" | "block" | "inconclusive";
export interface Project { id: string; organizationId: string; name: string; environment: { id: string; name: string }; createdAt: string }
export interface Principal { id: string; organizationId: string; projectIds: string[] | null; environmentIds: string[] | null; capabilities: string[] }
export interface Run {
  id: string; batchId: string; projectId: string; environmentId: string;
  scenario: Scenario; configuration: Configuration; repetition: number; target: Target;
  /** Digest of this retained scenario, never the latest project definition. */
  scenarioRevision?: string;
  measurements?: import("./run-measurements.js").RunMeasurements;
  execution: ExecutionState; attemptId: string | null; startedAt: string | null; finishedAt: string | null;
  output: Json | null; reason: string | null; assessment: AssessmentState; gate: GateState;
}
export interface Batch {
  id: string; projectId: string; environmentId: string; name: string; recipe: Recipe;
  targetExecution?: import("./target-execution.js").TargetExecutionDisclosure;
  operations?: import("./comparisons.js").BatchOperations;
  /** Declared submission channel, not proof that a target actually executed there. */
  submission?: import("./inspection-filters.js").SubmissionMetadata | null;
  createdAt: string; cancellationRequested: boolean; total: number;
  counts: Record<ExecutionState, number>; charge: { amount: 0; policy: "free_early_access" };
}
export interface ClaimedRun { run: Run; attemptId: string; leaseToken: string; leaseExpiresAt: string; limits: Recipe["limits"] }
export const SequenceCompletionSchema = z.object({
  ordinal: z.number().int().min(0).max(9999), execution: z.enum(["completed", "error", "interrupted", "cancelled"]),
  output: JsonSchema, reason: z.string().max(4000).nullable(), metrics: z.record(z.string(), JsonSchema),
}).strict();
export type SequenceCompletion = z.infer<typeof SequenceCompletionSchema>;
export type SequenceReply =
  | { state: "target"; ordinal: number; stepId: string; input: Json; deadline: string }
  | { state: "advance"; ordinal: number; stepId: string }
  | { state: "wait"; ordinal: number; stepId: string; waitMs: number }
  | { state: "finished"; execution: SequenceCompletion["execution"]; output: Json; reason: string | null; metrics: Record<string, Json> };
/** Claim progress excludes the complete recipe: the admitted runner already pinned it. */
export type BatchProgress = Omit<Batch, "recipe">;
export interface ClaimResponse { claim: ClaimedRun | null; batch: BatchProgress }
export interface RunEvent { id: string; sequence: number; kind: string; payload: Json; occurredAt: string; recordedAt: string; producer: string }
export interface CheckResult {
  id: string; state: "satisfied" | "violated" | "unknown"; required: boolean; actual: Json; expected: Json; reason: string;
  /** Absent on older retained results; no unit or tolerance is inferred for them. */
  comparator?: z.infer<typeof ExactCheckSchema>["comparator"]; numeric?: NumericCheck;
  /** Large operands remain in the immutable run/scenario, not duplicated in every check. Null plus this field means omitted, not a null observed value. */
  omittedValues?: { actual?: { bytes: number; sha256: string; path: string }; expected?: { bytes: number; sha256: string; checkId: string } };
  provenance?: { kind: "service_attested"; service: string; instanceId: string; epoch: number; observationDigest: string };
}
export interface DimensionResult { id: string; level: number | null; state: "assessed" | "not_assessable" | "not_applicable"; explanation: string; evidenceIds: string[]; providerScore?: import("./recommendations.js").JevProviderScore }
interface EvaluatorConfigurationPolicy {
  admission?: EvaluatorAdmissionPolicy;
  model: string; protocol: string; instructionsHash: string; maxInputBytes: number; maxEvidenceEvents: number;
  transport: { method: "POST"; redirect: "error"; timeoutMs: number; maxResponseBytes: number; retries: 0 | 2;
    retryableStatuses?: readonly [429, 503] | readonly [429, 529]; maximumRetryDelayMs?: number; ambiguousResponseRetry?: false };
}
export type EvaluatorConfiguration = EvaluatorConfigurationPolicy & (
  { provider: "anthropic"; endpoint: "https://api.anthropic.com/v1/messages"; apiVersion: "2023-06-01"; maxOutputTokens: number }
  | { provider: "jev"; endpoint: "https://api.typesafe.ai/v1/systemone"; apiVersion?: never; maxOutputTokens: null });
export interface Assessment { state: AssessmentState; checks: CheckResult[]; dimensions: DimensionResult[]; evaluator: { provider: string; model: string; version: string; configurationDigest?: string } | null; reason: string | null;
  /** Frozen numeric observations; absent on historical/unrequested results. Never automatic quality scores. */
  metrics?: import("./task-metrics.js").TaskMetricResult[];
  /** Optional derived read projection under the pinned authored rubric; never an automatic verdict. */
  composite?: import("./composite.js").CompositeResult }
export interface EvaluationAttempt {
  id: string; provider: string; model: string; version: string; state: string;
  inputHash: string; rubricHash: string; configuration: EvaluatorConfiguration | null;
  configurationDigest: string | null; usage: Json; createdAt: string; finishedAt: string | null;
  requestNumber?: number; previousAttemptId?: string | null; responseStatus?: number | null;
  retryDelayMs?: number | null; dispatchStartedAt?: string | null; reason?: string | null;
}
export interface AssessmentRecord {
  id: string; runId: string; kind: "initial" | "reassessment"; rubric: z.infer<typeof RubricSchema> | null;
  evidenceManifest: Json; evidenceHash: string; result: Assessment;
  gatePolicy: Recipe["gate"] | null; gate: GateState; createdAt: string; finishedAt: string | null;
  evaluationAttempts: EvaluationAttempt[];
}
export const REPORT_LINK_VERSION = "2026-10-16-report-link.1" as const;
/** Service-configured navigation only; the link contains no credential and grants no access. */
export interface ReportLink { schemaVersion: typeof REPORT_LINK_VERSION; kind: "portal" | "api"; url: string }
export interface RunReport { run: Run; assessment: Assessment; assessmentId?: string | null; events: RunEvent[]; nextCursor: string | null;
  /** Absent on older services. Exact retained run, not the latest run or a public share link. */
  reportLink?: ReportLink;
  activity?: import("./activity-filters.js").ActivityPageMetadata }
export const COMPACT_RESULT_VERSION = "2026-10-15-result.1" as const;
export interface BatchResult {
  batch: Batch; runs: Run[]; reportUrl: string; gate: GateState;
  /** Whole-population retained evidence/cleanup facts; absent is unknown on older services. */
  lifecycle?: import("./result-lifecycle.js").ResultLifecycle;
  /** Compact results describe the whole population but include only a bounded first page. */
  resultVersion?: typeof COMPACT_RESULT_VERSION;
  pagination?: { nextCursor: string | null; total: number; complete: boolean };
  assessmentCounts?: Record<AssessmentState, number>;
  /** Authoritative whole-population gate counts, including compact responses. Absence is unknown on earlier services. */
  gateCounts?: Record<GateState, number>;
}
export interface ApiError { error: { code: string; message: string; repair: string; requestId: string; details?: Json; validation?: import("./validation.js").ValidationDiagnostics } }
export const EventInputSchema = z.object({
  id: Id, kind: z.string().min(1).max(120), payload: JsonSchema,
  occurredAt: z.string().datetime().optional(),
}).strict();
export const FinishSchema = z.object({
  attemptId: Id, leaseToken: z.string().min(1).max(512),
  execution: z.enum(["completed", "error", "interrupted", "cancelled"]),
  output: JsonSchema.default(null), reason: z.string().max(4000).nullable().default(null),
  metrics: z.record(z.string(), JsonSchema).default({}),
}).strict();
export const ArtifactSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,159}$/),
  kind: z.enum(["screenshot", "trace", "browser_events", "recording", "file"]),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "application/zip", "application/json", "text/plain", "text/markdown", "application/pdf", "application/octet-stream", "video/webm"]),
  bytes: z.number().int().min(1).max(16 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.string().datetime(), metadata: z.record(z.string(), JsonSchema).default({}),
}).strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
export interface ArtifactReference extends Artifact { runId: string; attemptId: string; state: "pending" | "available"; uploadPath: string; downloadPath: string }
export * from "./github-ci.js";
