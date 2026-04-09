# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/discord-bot run dev` — run Discord bot

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Discord Bot (`artifacts/discord-bot`)

A Discord bot with a `/apwh-exam` slash command that:
- Joins the user's current voice channel
- Starts a 55-minute exam timer
- Plays audio beep warnings at 20, 10, and 5 minutes remaining
- Sends embed messages to the text channel at each warning
- Announces "Time is Up!" with a final beep when the 55 minutes expire

**Required secret:** `DISCORD_BOT_TOKEN`

**Dependencies:** `discord.js` v14, `@discordjs/voice`, `ffmpeg-static`, `opusscript`, `libsodium-wrappers`

**Workflow:** `Discord Bot` — runs `pnpm --filter @workspace/discord-bot run dev`
