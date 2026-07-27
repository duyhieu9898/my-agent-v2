import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;

type SourceFile = Readonly<{ path: string; text: string }>;

function sourceFiles(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [{ path: relative(root, path), text: readFileSync(path, "utf8") }]
      : [];
  });
}

function diagnostics(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (file.path.endsWith(".test.ts")) continue;
    const imports = [...file.text.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1]!,
    );
    const restrictedDomain = /^(gateway|agents|context)\//.test(file.path);
    for (const specifier of imports) {
      if (
        restrictedDomain &&
        (/sqlite-[^"']*/.test(specifier) || specifier === "@google/genai")
      )
        violations.push(`${file.path}: ${specifier}: restricted domain import`);
      if (
        /^gateway\//.test(file.path) &&
        (specifier.includes("gemini-interactions-provider") ||
          specifier === "@google/genai")
      )
        violations.push(`${file.path}: ${specifier}: gateway provider import`);
      if (
        !/^bootstrap\//.test(file.path) &&
        /sqlite-(run|session|transcript)-store/.test(specifier) &&
        /^bootstrap\//.test(file.path) === false &&
        /(createGateway|createApp)/.test(file.text)
      )
        violations.push(
          `${file.path}: ${specifier}: concrete composition outside bootstrap`,
        );
    }
  }
  return violations;
}

describe("production import boundaries", () => {
  it("keeps concrete SQLite and Gemini SDK imports behind their owned boundaries", () => {
    expect(diagnostics(sourceFiles(root))).toEqual([]);
  });

  it("reports every forbidden import with file, specifier, and boundary", () => {
    const violations = diagnostics([
      {
        path: "gateway/bad.ts",
        text: 'import x from "../sessions/sqlite-transcript-store.js";',
      },
      { path: "gateway/gemini.ts", text: 'import x from "@google/genai";' },
      {
        path: "gateway/provider.ts",
        text: 'import x from "../models/gemini-interactions-provider.js";',
      },
      {
        path: "agents/bad.ts",
        text: 'import x from "../sessions/sqlite-session-store.js";',
      },
      { path: "agents/sdk.ts", text: 'import x from "@google/genai";' },
      {
        path: "context/bad.ts",
        text: 'import x from "../sessions/sqlite-transcript-store.js";',
      },
      { path: "context/sdk.ts", text: 'import x from "@google/genai";' },
      {
        path: "runtime/compose.ts",
        text: 'import x from "../agents/sqlite-run-store.js"; createGateway(x);',
      },
    ]);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "gateway/bad.ts: ../sessions/sqlite-transcript-store.js: restricted domain import",
        ),
        expect.stringContaining(
          "gateway/gemini.ts: @google/genai: gateway provider import",
        ),
        expect.stringContaining(
          "agents/bad.ts: ../sessions/sqlite-session-store.js: restricted domain import",
        ),
        expect.stringContaining(
          "context/sdk.ts: @google/genai: restricted domain import",
        ),
        expect.stringContaining(
          "runtime/compose.ts: ../agents/sqlite-run-store.js: concrete composition outside bootstrap",
        ),
      ]),
    );
  });

  it("permits contracts, type-only imports, bootstrap composition, and test-like fixtures", () => {
    expect(
      diagnostics([
        {
          path: "gateway/types.ts",
          text: 'import type { RunStore } from "../agents/run-store.js";',
        },
        {
          path: "agents/contracts.ts",
          text: 'import type { TranscriptStore } from "../sessions/transcript-store.js";',
        },
        {
          path: "bootstrap/create-app.ts",
          text: 'import { SqliteRunStore } from "../agents/run-store.js"; createGateway();',
        },
        {
          path: "agents/example.test.ts",
          text: 'import { SqliteRunStore } from "../agents/sqlite-run-store.js";',
        },
      ]),
    ).toEqual([]);
  });
});
