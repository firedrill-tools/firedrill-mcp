import { z } from "zod";
export const TARGET_EXECUTION_VERSION = "2026-10-16-target-execution.1";
/** An explicit shared-state acknowledgement, not a reset or isolation guarantee. */
export const TargetExecutionPolicySchema = z.object({
    schemaVersion: z.literal(TARGET_EXECUTION_VERSION),
    nonHermeticParallel: z.literal("acknowledged"),
}).strict();
function acknowledged(recipe) {
    return TargetExecutionPolicySchema.safeParse(recipe.targetExecution).success;
}
/** Admission and dispatch use this separately from historical recipe parsing.
 * Reading an old record must not rewrite its missing acknowledgement. */
export function targetExecutionViolation(recipe) {
    if (recipe.target.kind === "isolated_node" || (recipe.concurrency ?? 1) <= 1 || acknowledged(recipe))
        return null;
    return {
        code: "FD_NON_HERMETIC_PARALLEL_ACK_REQUIRED",
        message: "Parallel command, HTTP and native targets may share application state; this recipe has no retained acknowledgement.",
        repair: `Choose concurrency 1 or deliberately submit a new recipe with targetExecution: {schemaVersion: '${TARGET_EXECUTION_VERSION}', nonHermeticParallel: 'acknowledged'} after reviewing shared application state. Do not change an admitted recipe during run or recovery. This declaration does not reset or isolate the target.`,
    };
}
/** Describe the retained contract only. Even an isolated-runner declaration is
 * not proof that a particular invocation satisfied that contract. */
export function targetExecutionDisclosure(recipe) {
    const requestedConcurrency = recipe.concurrency ?? 1;
    const explicit = acknowledged(recipe);
    return {
        schemaVersion: TARGET_EXECUTION_VERSION,
        requestedConcurrency,
        acknowledgement: explicit ? "caller_declared" : "not_recorded",
        mode: recipe.target.kind === "isolated_node" ? "isolated_runner_contract"
            : requestedConcurrency <= 1 ? "sequential_non_hermetic"
                : explicit ? "acknowledged_shared_state" : "unacknowledged_parallel",
        automaticTargetReset: false,
        isolationAttestation: "not_provided",
    };
}
