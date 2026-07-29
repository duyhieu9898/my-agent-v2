import { createHash } from "node:crypto";
import AjvModule from "ajv";
import { AppError } from "../core/errors.js";
import {
  canonicalJsonStringify,
  strictJsonSnapshot,
  type ToolDescriptor,
  type ToolExecutionContext,
  type ToolRegistration,
} from "./contracts.js";

const Ajv = AjvModule.default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });

export class ToolRegistry {
  private readonly descriptors = new Map<string, ToolDescriptor>();
  readonly #implementations = new Map<
    string,
    {
      execute: (args: any, context: ToolExecutionContext) => Promise<any>;
      approvalSummaryRenderer: (args: any) => string;
    }
  >();
  private frozen = false;
  private cachedFingerprint: string | null = null;
  private readonly compiledSchemas = new Map<
    string,
    {
      argValidate: ReturnType<typeof ajv.compile>;
      resValidate: ReturnType<typeof ajv.compile>;
    }
  >();

  public register(tool: ToolRegistration): void {
    if (this.frozen) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        "Cannot register tool after registry is frozen",
      );
    }
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(tool.name)) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        `Invalid tool name format '${tool.name}'. Must be lowercase dotted identity`,
      );
    }
    if (this.descriptors.has(tool.name)) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        `Tool '${tool.name}' is already registered`,
      );
    }

    const argValidate = ajv.compile(tool.argumentSchema);
    const resValidate = ajv.compile(tool.resultSchema);

    const metadata: ToolDescriptor = {
      name: tool.name,
      descriptorVersion: tool.descriptorVersion,
      owningModule: tool.owningModule,
      description: tool.description,
      argumentSchema: tool.argumentSchema,
      resultSchema: tool.resultSchema,
      effectClassification: tool.effectClassification,
      sensitivityClassification: tool.sensitivityClassification,
      executionTarget: tool.executionTarget,
      sandboxRequirement: tool.sandboxRequirement,
      timeoutMs: tool.timeoutMs,
      cancellationSupport: tool.cancellationSupport,
      concurrencyTrait: tool.concurrencyTrait,
      idempotencyTrait: tool.idempotencyTrait,
      approvalSummaryRendererVersion:
        tool.approvalSummaryRendererVersion ?? "1.0.0",
      redactionRules: tool.redactionRules,
      inputLimits: tool.inputLimits,
      outputLimits: tool.outputLimits,
      progressFingerprintVersion: tool.progressFingerprintVersion,
    };

    const publishedDescriptor = strictJsonSnapshot(metadata);

    this.descriptors.set(tool.name, publishedDescriptor);
    // Keep the executable authority detached from the caller-owned registration
    // object. Consumers get only the narrow operations below, never this record.
    this.#implementations.set(
      tool.name,
      Object.freeze({
        execute: tool.execute,
        approvalSummaryRenderer: tool.approvalSummaryRenderer,
      }),
    );
    this.compiledSchemas.set(tool.name, { argValidate, resValidate });
    this.cachedFingerprint = null;
  }

  public freeze(): void {
    this.frozen = true;
    this.computeFingerprint();
  }

  public isFrozen(): boolean {
    return this.frozen;
  }

  public get(name: string): ToolDescriptor | undefined {
    return this.descriptors.get(name);
  }

  public list(): ToolDescriptor[] {
    return Array.from(this.descriptors.values());
  }

  public renderApprovalSummary(
    name: string,
    args: Record<string, unknown>,
  ): string {
    const implementation = this.#implementations.get(name);
    if (!implementation) {
      throw new AppError(
        "TOOL_NOT_FOUND",
        `Tool implementation '${name}' is missing`,
      );
    }
    return implementation.approvalSummaryRenderer(args);
  }

  public execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const implementation = this.#implementations.get(name);
    if (!implementation) {
      throw new AppError(
        "TOOL_NOT_FOUND",
        `Tool implementation '${name}' is missing`,
      );
    }
    return implementation.execute(args, context);
  }

  public computeToolFingerprint(tool: ToolDescriptor): string {
    const serializable: ToolDescriptor = {
      name: tool.name,
      descriptorVersion: tool.descriptorVersion,
      owningModule: tool.owningModule,
      description: tool.description,
      argumentSchema: tool.argumentSchema,
      resultSchema: tool.resultSchema,
      effectClassification: tool.effectClassification,
      sensitivityClassification: tool.sensitivityClassification,
      executionTarget: tool.executionTarget,
      sandboxRequirement: tool.sandboxRequirement,
      timeoutMs: tool.timeoutMs,
      cancellationSupport: tool.cancellationSupport,
      concurrencyTrait: tool.concurrencyTrait,
      idempotencyTrait: tool.idempotencyTrait,
      approvalSummaryRendererVersion:
        tool.approvalSummaryRendererVersion ?? "1.0.0",
      redactionRules: tool.redactionRules,
      inputLimits: tool.inputLimits,
      outputLimits: tool.outputLimits,
      progressFingerprintVersion: tool.progressFingerprintVersion,
    };

    const canonical = canonicalJsonStringify(serializable);
    return createHash("sha256").update(canonical).digest("hex");
  }

  public computeFingerprint(): string {
    if (this.cachedFingerprint) {
      return this.cachedFingerprint;
    }

    const sortedToolNames = Array.from(this.descriptors.keys()).sort();
    const hashes = sortedToolNames.map((name) => {
      const tool = this.descriptors.get(name)!;
      return `${name}:${this.computeToolFingerprint(tool)}`;
    });

    this.cachedFingerprint = createHash("sha256")
      .update(hashes.join("\n"))
      .digest("hex");

    return this.cachedFingerprint;
  }

  public validateArguments(
    toolName: string,
    args: unknown,
  ):
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; error: string } {
    const schemas = this.compiledSchemas.get(toolName);
    if (!schemas) {
      return { ok: false, error: `Unknown tool '${toolName}'` };
    }

    let clonedArgs: unknown;
    try {
      clonedArgs =
        typeof args === "object" && args !== null
          ? strictJsonSnapshot(args)
          : args;
    } catch (err: any) {
      return { ok: false, error: err.message ?? "Invalid arguments" };
    }

    const valid = schemas.argValidate(clonedArgs);
    if (!valid) {
      const errors =
        schemas.argValidate.errors
          ?.map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
          .join("; ") ?? "Invalid arguments";
      return { ok: false, error: errors };
    }

    return { ok: true, value: clonedArgs as Record<string, unknown> };
  }

  public validateResult(
    toolName: string,
    result: unknown,
  ): { ok: true } | { ok: false; error: string } {
    const schemas = this.compiledSchemas.get(toolName);
    if (!schemas) {
      return { ok: false, error: `Unknown tool '${toolName}'` };
    }

    const valid = schemas.resValidate(result);
    if (!valid) {
      const errors =
        schemas.resValidate.errors
          ?.map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
          .join("; ") ?? "Invalid result";
      return { ok: false, error: errors };
    }

    return { ok: true };
  }
}
