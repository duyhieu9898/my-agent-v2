import { AppError } from "../core/errors.js";

import type { Harness } from "./harness.js";

/**
 * Bootstrap-owned registry of harness implementations. The runtime resolves the
 * implementation for a run from the resolved agent snapshot's `harnessId`.
 * Unknown ids fail typed resolution with no fallback; duplicate ids fail at
 * construction. The registry never imports the provider SDK.
 */
export class HarnessRegistry {
  private readonly harnesses: ReadonlyMap<string, Harness>;

  public constructor(
    entries: readonly Readonly<{ id: string; harness: Harness }>[],
  ) {
    const table = new Map<string, Harness>();
    for (const entry of entries) {
      if (table.has(entry.id))
        throw new AppError(
          "DOMAIN_VALIDATION_FAILED",
          `DUPLICATE_HARNESS_DEFINITION: ${entry.id}`,
        );
      table.set(entry.id, entry.harness);
    }
    this.harnesses = table;
  }

  public resolve(harnessId: string): Harness {
    const harness = this.harnesses.get(harnessId);
    if (!harness)
      throw new AppError("HARNESS_NOT_FOUND", `Unknown harness: ${harnessId}`);
    return harness;
  }
}
