import { z } from "zod";
import { ScenarioSchema } from "./index.js";
export const RECOMMENDATION_VERSION = "2026-10-18-recommendations.1";
const Id = z.string().min(1).max(160);
const Anchor = z.object({ level: z.number().int().min(0).max(4), description: z.string().min(1).max(4000) }).strict();
export const RecommendationCriterionSchema = z.object({ id: Id, name: z.string().min(1).max(200), instructions: z.string().min(1).max(4000),
    anchors: z.array(Anchor).length(5),
}).strict().superRefine((value, context) => { if (value.anchors.some((anchor, index) => anchor.level !== index))
    context.addIssue({ code: "custom", path: ["anchors"], message: "Declare five ordered anchors with levels 0 through 4." }); });
export const ScenarioRecommendationRequestSchema = z.object({ projectId: Id, environmentId: Id,
    candidates: z.array(z.lazy(() => ScenarioSchema)).min(1).max(10000), criteria: z.array(RecommendationCriterionSchema).min(1).max(12), context: z.string().max(64000).optional(),
}).strict().superRefine((value, context) => {
    if (new Set(value.candidates.map(item => item.id)).size !== value.candidates.length)
        context.addIssue({ code: "custom", path: ["candidates"], message: "Candidate scenario IDs must be unique." });
    if (new Set(value.criteria.map(item => item.id)).size !== value.criteria.length)
        context.addIssue({ code: "custom", path: ["criteria"], message: "Criterion IDs must be unique." });
});
export const JevProviderScoreSchema = z.object({ provider: z.literal("jev"), score: z.number().finite().min(0).max(4), confidence: z.number().finite().min(0).max(1),
    probabilities: z.array(z.object({ level: z.number().int().min(0).max(4), description: z.string(), probability: z.number().finite().min(0).max(1) }).strict()).length(5),
    modalLevels: z.array(z.number().int().min(0).max(4)).min(1).max(5), ordinalConversion: z.literal("none"),
    evidenceAttribution: z.literal("supplied_evidence_set_not_provider_selected_citations"),
}).strict();
export const RecommendationDimensionSchema = z.object({ criterionId: Id, state: z.enum(["assessed", "not_assessable"]),
    score: z.number().finite().min(0).max(4).nullable(), level: z.number().int().min(0).max(4).nullable(), confidence: z.number().finite().min(0).max(1).nullable(),
    probabilities: z.array(z.object({ level: z.number().int().min(0).max(4), description: z.string(), probability: z.number().finite().min(0).max(1) }).strict()).max(5),
}).strict();
export const ScenarioRecommendationSchema = z.object({ schemaVersion: z.literal(RECOMMENDATION_VERSION), id: Id, projectId: Id, environmentId: Id,
    state: z.enum(["pending", "completed", "partial", "unavailable"]),
    candidates: z.array(z.object({ scenario: z.lazy(() => ScenarioSchema), dimensions: z.array(RecommendationDimensionSchema), score: z.number().finite().min(0).max(4).nullable(), rank: z.number().int().min(1).nullable() }).strict()),
    reason: z.string().nullable(), provider: z.object({ provider: z.literal("jev"), model: z.string(), protocol: z.literal("jev-systemone-recommendations-2026-10-18.1") }).strict().nullable(), createdAt: z.string().datetime(),
}).strict();
