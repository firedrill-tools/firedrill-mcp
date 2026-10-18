import { z } from "zod";
import type { Assessment, CheckResult, DimensionResult } from "./index.js";

/** Explicit presentation policy, never a universal score or release verdict. */
export const COMPOSITE_VERSION = "2026-10-16-composite.1" as const;
export const CompositePolicySchema = z.object({
  schemaVersion: z.literal(COMPOSITE_VERSION), method: z.literal("weighted_mean_ordinal"),
  weights: z.array(z.object({ dimensionId: z.string().min(1).max(160), weight: z.number().int().min(1).max(1000) }).strict()).min(1).max(12),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.weights.map(item => item.dimensionId)).size !== value.weights.length)
    ctx.addIssue({ code: "custom", path: ["weights"], message: "Each selected dimension must have exactly one positive weight." });
});
export type CompositePolicy = z.infer<typeof CompositePolicySchema>;
export interface CompositeComponent {
  dimensionId: string; weight: number;
  state: "assessed" | "not_applicable" | "not_assessable" | "missing" | "invalid";
  level: number | null;
}
export interface CompositeResult {
  schemaVersion: typeof COMPOSITE_VERSION; policy: CompositePolicy;
  state: "computed" | "not_assessable" | "constraint_violation";
  /** A descriptive weighted index of authored ordinal coding, not a rubric level or probability. */
  value: number | null; scale: { minimum: 0; maximum: 4 };
  numerator: number | null; denominator: number;
  components: CompositeComponent[];
  requiredExactChecks: { state: "not_requested" | "satisfied" | "violated" | "unknown";
    requested: number; satisfied: number; violated: number; unknown: number; missing: number };
  reason: "complete" | "assessment_unavailable" | "missing_dimension" | "excluded_dimension" | "invalid_dimension" | "required_check_violated" | "required_check_unknown";
  semantics: { missingEvidence: "not_assessable"; notApplicable: "not_assessable_without_reweighting";
    requiredExactChecks: "must_be_satisfied"; gate: "unchanged"; formula: "sum(weight * level) / sum(weight)" };
}
type Rubric = { composite?: CompositePolicy; dimensions: readonly { id: string }[] };
type CheckDefinition = { id: string; required: boolean };
const validLevel = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4;

/** Derived exclusively from frozen assessment results and the exact authored
 * policy/check definitions. No evaluator call, mutation or hidden renormalizing. */
export function deriveComposite(rubric: Rubric | null | undefined,
  assessment: Pick<Assessment, "state" | "dimensions" | "checks">,
  definitions: readonly CheckDefinition[]): CompositeResult | undefined {
  if (!rubric?.composite) return;
  const policy = CompositePolicySchema.parse(rubric.composite);
  const components: CompositeComponent[] = policy.weights.map(({ dimensionId, weight }) => {
    const values = assessment.dimensions.filter(item => item.id === dimensionId);
    const value: DimensionResult | undefined = values[0];
    if (!rubric.dimensions.some(item => item.id === dimensionId) || values.length > 1)
      return { dimensionId, weight, state: "invalid", level: null };
    if (!value) return { dimensionId, weight, state: "missing", level: null };
    if (value.state === "assessed" && validLevel(value.level)) return { dimensionId, weight, state: "assessed", level: value.level };
    if (["not_applicable", "not_assessable"].includes(value.state) && value.level === null)
      return { dimensionId, weight, state: value.state as "not_applicable" | "not_assessable", level: null };
    return { dimensionId, weight, state: "invalid", level: null };
  });
  const requested = definitions.filter(item => item.required);
  let satisfied = 0, violated = 0, unknown = 0, missing = 0;
  for (const definition of requested) {
    const values: CheckResult[] = assessment.checks.filter(item => item.id === definition.id && item.required);
    if (!values.length) missing++;
    else if (values.length !== 1) unknown++;
    else if (values[0]!.state === "satisfied") satisfied++;
    else if (values[0]!.state === "violated") violated++;
    else unknown++;
  }
  const constraints: CompositeResult["requiredExactChecks"] = {
    state: violated ? "violated" : unknown || missing ? "unknown" : requested.length ? "satisfied" : "not_requested",
    requested: requested.length, satisfied, violated, unknown, missing,
  };
  const reason: CompositeResult["reason"] = violated ? "required_check_violated" : unknown || missing ? "required_check_unknown"
    : !["completed", "partial"].includes(assessment.state) ? "assessment_unavailable"
    : components.some(item => item.state === "invalid") ? "invalid_dimension"
    : components.some(item => item.state === "not_applicable") ? "excluded_dimension"
    : components.some(item => item.state !== "assessed") ? "missing_dimension" : "complete";
  const denominator = components.reduce((sum, item) => sum + item.weight, 0);
  const numerator = reason === "complete" ? components.reduce((sum, item) => sum + item.weight * item.level!, 0) : null;
  return { schemaVersion: COMPOSITE_VERSION, policy, state: violated ? "constraint_violation" : reason === "complete" ? "computed" : "not_assessable",
    value: numerator === null ? null : numerator / denominator, numerator, denominator, components, requiredExactChecks: constraints, reason,
    scale: { minimum: 0, maximum: 4 }, semantics: { missingEvidence: "not_assessable", notApplicable: "not_assessable_without_reweighting",
      requiredExactChecks: "must_be_satisfied", gate: "unchanged", formula: "sum(weight * level) / sum(weight)" } };
}

/** Read-only projection; old persisted assessments are never rewritten. */
export function assessmentWithComposite<T extends Assessment>(rubric: Rubric | null | undefined, assessment: T, definitions: readonly CheckDefinition[]): T {
  const { composite: _old, ...retained } = assessment;
  const composite = deriveComposite(rubric, assessment, definitions);
  return { ...retained, ...(composite ? { composite } : {}) } as T;
}
