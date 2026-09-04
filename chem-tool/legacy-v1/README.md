# chem-tool legacy v1 (`chemistry-tool`)

The first generation of the chemistry tool: Node 22 + Hono + a vanilla-TS client,
npm-managed. Superseded by the Bun + React rewrite in the parent `chem-tool/`
directory, but kept because it still holds code the rewrite does not have:

- `src/chem/balance.ts` — equation balancing
- `src/chem/lattice.ts` — crystal lattice generation
- `server/openapi.ts` — OpenAPI document for the REST API
- `server/mcp-stdio.ts` — stdio MCP transport (the rewrite is HTTP-only)
- `server/connect.ts`, `server/service.ts` — the old service layer
- `scripts/build-library.ts` — offline compound library builder

Archived here on 2026-09-04; it was previously a top-level `Chemistry Tool/`
folder that had never been committed. Not wired into the parent build — it has
its own `package.json` and `package-lock.json` and runs standalone with npm.
