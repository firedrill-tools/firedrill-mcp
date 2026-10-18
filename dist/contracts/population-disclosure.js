import { z } from "zod";
/** Why the author selected these cases, separate from how a matrix was generated. */
export const POPULATION_PURPOSE_VERSION = "2026-10-16-population-purpose.1";
export const POPULATION_DISCLOSURE_VERSION = "2026-10-16-population-disclosure.1";
export const PopulationPurposeSchema = z.object({
    schemaVersion: z.literal(POPULATION_PURPOSE_VERSION),
    kind: z.enum(["exploration", "fixed_suite", "held_out", "failure_selected"]),
    rationale: z.string().min(1).max(2000).optional(),
}).strict();
/** Read-only projection of the retained recipe, never an independence attestation. */
export function populationDisclosure(recipe) {
    return {
        schemaVersion: POPULATION_DISCLOSURE_VERSION,
        purpose: recipe.populationPurpose
            ? { state: "declared", declaration: recipe.populationPurpose }
            : { state: "not_recorded", declaration: null },
        materialization: recipe.population
            ? { state: "recorded", provenance: recipe.population }
            : { state: "not_recorded", provenance: null },
        verification: "not_independently_verified",
        notes: [
            "Population purpose is a retained caller declaration. A held-out label does not prove that cases were unseen, independently selected or withheld from target/evaluator development.",
            "Failure-selected and exploratory populations do not estimate production incidence. A fixed suite or seeded sample is not automatically representative.",
            "Materialization provenance records declared matrix/sample selection, candidate count, seed, indices and source digests. It is separate from admitted runs, actual target attempts and evaluated outcomes; it is not an independent source-verification receipt.",
            "Missing purpose or materialization metadata stays not_recorded. Nothing is inferred from a recipe name, scenario description, outcome or score; this disclosure changes no execution, assessment or gate.",
        ],
    };
}
