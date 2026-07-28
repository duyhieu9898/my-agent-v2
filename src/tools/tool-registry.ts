import { createHash } from "node:crypto";
import AjvModule from "ajv";
import { AppError } from "../core/errors.js";
import type { ToolDescriptor } from "./contracts.js";

const Ajv = AjvModule.default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();
  private frozen = false;
  private cachedFingerprint: string | null = null;
  private readonly compiledSchemas = new Map<
    string,
    {
      argValidate: ReturnType<typeof ajv.compile>;
      resValidate: ReturnType<typeof ajv.compile>;
    }
  >();

  public register(tool: ToolDescriptor): void {
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
    if (this.tools.has(tool.name)) {
      throw new AppError(
        "TOOL_IMPLEMENTATION_FAILED",
        `Tool '${tool.name}' is already registered`,
      );
    }

    const argValidate = ajv.compile(tool.argumentSchema);
    const resValidate = ajv.compile(tool.resultSchema);

    this.tools.set(tool.name, tool);
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
    return this.tools.get(name);
  }

  public list(): ToolDescriptor[] {
    return Array.from(this.tools.values());
  }

  public computeToolFingerprint(tool: ToolDescriptor): string {
    const canonical = JSON.stringify({
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
      concurrencyTrait: tool.concurrencyTrait,
      idempotencyTrait: tool.idempotencyTrait,
      progressFingerprintVersion: tool.progressFingerprintVersion,
    });

    return createHash("sha256").update(canonical).digest("hex");
  }

  public computeFingerprint(): string {
    if (this.cachedFingerprint) {
      return this.cachedFingerprint;
    }

    const sortedToolNames = Array.from(this.tools.keys()).sort();
    const hashes = sortedToolNames.map((name) => {
      const tool = this.tools.get(name)!;
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

    const valid = schemas.argValidate(args);
    if (!valid) {
      const errors =
        schemas.argValidate.errors
          ?.map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
          .join("; ") ?? "Invalid arguments";
      return { ok: false, error: errors };
    }

    return { ok: true, value: args as Record<string, unknown> };
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
