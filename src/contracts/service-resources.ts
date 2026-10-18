/** Configured limits, not billing, a reservation or predicted resource use. */
export interface ServiceResourceEnvelope {
  schemaVersion: "2026-10-17-tool-resources.1";
  basis: "enforced_configuration_not_measured_usage";
  runtime: {
    wasmLinearMemoryLimitBytes: number; stackLimitBytes: number;
    operationTimeLimitMs: number; initializationTimeLimitMs: number;
    hostCallsPerOperation: number; inputLimitBytes: number; outputLimitBytes: number;
    artifactLimitBytes: number; reinstantiationsPerMinute: number;
    sessionTimeBudget: { windowMs: number; admissionLimitMs: number;
      accounting: "elapsed_handler_time_not_os_cpu"; scope: "instance_process_lifetime"; inFlightMayExceedBudget: true };
  };
  build: { maxConcurrent: number; timeoutMs: number; submittedSourceLimitBytes: number;
    workerV8OldSpaceLimitBytes: number; workerOutputLimitBytes: number };
  estimate: { basis: "one_new_instance_configured_ceiling"; instanceSlots: number;
    defaultLifetimeSeconds: number; wasmLinearMemoryCeilingBytes: number;
    measuredCpuMs: null; measuredMemoryBytes: null; reserved: false };
  limitations: string[];
}
