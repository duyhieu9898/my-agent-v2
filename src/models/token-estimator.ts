/**
 * Provider-neutral token estimation at the model/context boundary.
 *
 * This is a deterministic ESTIMATE used for a hard pre-dispatch context budget
 * check. It is NOT provider-exact billing usage and makes no precision claim.
 * Exact provider token counting remains a provider-owned concern that may only
 * be consulted through the model contract; this estimator never calls a
 * provider and performs no network I/O.
 */
export interface TokenEstimator {
  /** Version of the estimation algorithm. Affects execution identity when budgeted. */
  readonly revision: string;
  estimate(input: {
    instructions: readonly string[];
    turns: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
    continuations?: readonly Readonly<{ payload: Uint8Array }>[];
  }): bigint;
}

/**
 * Heuristic estimator. Counts UTF-8 bytes across prompt sections and required
 * continuation sidecars and divides by a fixed characters-per-token ratio,
 * rounding up to at least one token. Deterministic for any Unicode input.
 *
 * `revision` names this exact algorithm; changing the ratio or units requires a
 * new revision so the resolved resource manifest hash changes for later runs.
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  public readonly revision = "heuristic-v1";
  // ~4 UTF-8 bytes per token is a conservative latin-script heuristic.
  private static readonly bytesPerToken = 4;

  public estimate(input: {
    instructions: readonly string[];
    turns: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
    continuations?: readonly Readonly<{ payload: Uint8Array }>[];
  }): bigint {
    let bytes = 0;
    for (const instruction of input.instructions)
      bytes += Buffer.byteLength(instruction, "utf8");
    for (const turn of input.turns)
      bytes += Buffer.byteLength(turn.text, "utf8");
    for (const continuation of input.continuations ?? [])
      bytes += continuation.payload.length;
    return BigInt(
      Math.max(1, Math.ceil(bytes / HeuristicTokenEstimator.bytesPerToken)),
    );
  }
}
