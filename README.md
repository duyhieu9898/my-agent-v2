# my-agent-v2

A small, local-first personal agent for Linux with deliberate extension seams for additional operating systems, channels, agents, and tool providers.

## Requirements

- Node.js 22.12+
- pnpm 10+

## Start

```bash
corepack enable
corepack prepare pnpm@10 --activate
pnpm install
pnpm dev
```

- API: http://127.0.0.1:3210
- Web: http://127.0.0.1:5173

## Current scope

This repository is only the architecture skeleton. It contains contracts and placeholder implementations, not a functioning LLM agent yet.
