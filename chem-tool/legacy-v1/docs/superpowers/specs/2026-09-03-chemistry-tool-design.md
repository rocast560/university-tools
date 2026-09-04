# Chemistry Tool: design

Date: 2026-09-03. Status: built autonomously from the request. Every decision
below is one the request left open; all of them can be changed later.

## The request

"Give it a formula and/or a name for a chemical and it makes a 3D model and a
2D model of what it is supposed to look like. Cover as many chemicals as
possible, especially the ones in engineering chemistry classes. Add an MCP
connection so Claude Desktop or the ChatGPT desktop app can use it, plus an
open API so either MCP or the desktop apps can call it. Use the most efficient
web technology so it renders quickly."

## Goals

1. Type `H2O`, `water`, `CH3COOH`, `acetic acid`, `C6H12O6`, `NaCl`, a CAS
   number or a SMILES string and see, within a few hundred milliseconds, the
   2D skeletal structure and a rotatable 3D ball and stick model.
2. Cover the engineering chemistry canon offline (several hundred compounds,
   curated and formula checked) and fall back to PubChem (110 million
   compounds) for everything else.
3. Expose every capability as plain HTTP JSON (`/api/*`, documented by
   `/openapi.json`) and as MCP tools (`/mcp` over Streamable HTTP, and a stdio
   entry point for clients that launch a command).
4. Give the user copy and paste connection snippets for Claude Desktop, Claude
   Code, ChatGPT and any OpenAPI client, with the real absolute path filled in.

## Non goals

- No accounts, no persistence of user data, no cloud deployment.
- No quantum chemistry: 3D geometry comes from PubChem's MMFF94 conformers or
  from OpenChemLib's conformer generator, which is what textbook models show.
- Crystal lattices are idealised unit cell clusters, not measured structures.

## Architecture

One Node process (Node 22.18+ runs TypeScript directly, so the server has no
build step) and one Vite built static client.

```
browser  --HTTP-->  Hono server (server/index.ts)
Claude Code / Desktop connectors --Streamable HTTP--> /mcp
Claude Desktop (stdio) --> server/mcp-stdio.ts (same tool set, in process)
ChatGPT --> /mcp or /openapi.json (needs a public URL, see README)
                      |
                      v
            src/chem/* (pure TypeScript; only pubchem.ts does I/O)
            resolve -> library | smiles | pubchem -> structure (OpenChemLib)
                      |
                      v
            data/library.json + data/sdf/*.sdf (from scripts/build-library.ts)
```

### Modules (`src/chem`)

- `elements.ts`: periodic table (symbol, name, atomic mass, CPK colour,
  covalent radius). Pure data.
- `formula.ts`: parse a formula (`Ca(OH)2`, `CuSO4.5H2O`, `CH3CH2OH`,
  unicode subscripts) into element counts; Hill order string; molar mass;
  mass percent composition. Pure.
- `library.ts`: loads `data/library.json`, builds indexes (by normalised
  name/alias, by Hill formula, by CAS, by CID), exposes `findByName`,
  `findByFormula`, `search` (prefix and substring for autocomplete).
- `structure.ts`: OpenChemLib wrappers. SMILES to 2D SVG; SMILES to 3D
  molfile (conformer generator, hydrogens added); disconnected fragments
  (ionic formula units) are laid out side by side; molfile to atom and bond
  arrays.
- `render3d.ts`: software rendered 3D snapshot (rotate, depth sort, spheres
  as radial gradients, bonds as lines) to SVG, so MCP clients that cannot run
  WebGL still get a picture. PNG via resvg.
- `lattice.ts`: procedural unit cell clusters (SC, BCC, FCC, HCP, diamond,
  rock salt, CsCl, zinc blende, fluorite, perovskite, graphite) as atom lists.
- `balance.ts`: chemical equation balancer (integer nullspace).
- `pubchem.ts`: PUG REST client (name/formula/CID to properties, 2D/3D SDF),
  rate limited, disk cached under `cache/`.
- `resolve.ts`: the pipeline. Normalise query, then library by name, library
  by formula, SMILES parse, PubChem by name, PubChem by formula. Returns a
  `Resolved` record with the match, the 2D SVG, the 3D structure and
  alternatives (other compounds sharing the formula).

### Server (`server/`)

- `index.ts`: Hono app on `127.0.0.1:8140` (sibling projects use 8090 and
  8765). Serves `dist/` with immutable caching, `/api/*`, `/openapi.json`,
  `/mcp`. CORS open (local tool).
- `api.ts`: REST routes, all GET, all JSON except the image routes.
- `mcp.ts`: `McpServer` with tools `lookup_chemical`, `render_2d`,
  `render_3d`, `get_structure`, `search_chemicals`, `list_library`,
  `formula_info`, `balance_equation`, `crystal_lattice`. One server
  instance per request (stateless transport).
- `mcp-stdio.ts`: the same `McpServer` over stdio, in process, so it works
  even when the HTTP server is not running.
- `openapi.ts`: OpenAPI 3.1 document for the REST routes.

### Client (`src/client`, Vite, vanilla TypeScript)

- No framework: a search box (debounced autocomplete from `/api/search`), a
  result view (2D SVG inlined, 3D through 3Dmol.js in a lazily loaded chunk,
  style buttons, spin, labels, download SDF/PNG), a browse view (library by
  category), and a connect view (snippets).
- URL carries `?q=` so links from MCP tool results open the same view.
- 3Dmol.js is the only client side chemistry dependency and loads only when
  a result is shown. The 2D image is server rendered SVG (zero client cost).

### Data pipeline (`scripts/build-library.ts`)

`data/seed.ts` lists the compounds as `{name, formula, aliases, category,
note}` with the formula I expect. The script asks PubChem for each name,
verifies the returned Hill formula matches (mismatches are printed and the
entry is skipped, never silently wrong), stores SMILES, IUPAC name, CID,
molar mass, and fetches the PubChem 3D conformer SDF (falling back to
OpenChemLib when PubChem has none, which is the case for salts). Output is
committed so the app works offline.

## Efficiency choices

- Server: Hono (fastest mainstream Node router), in memory LRU for resolved
  records, precomputed 3D for the library, compression, and
  `Cache-Control: immutable` for hashed assets.
- Client: a few KB of app code plus a lazy 3Dmol chunk; SVG 2D; no framework
  runtime; no web fonts.

## Error handling

- Unknown chemical: 404 with `suggestions` (closest library names).
- PubChem down: the library still works; the response says which source
  answered and, on failure, why the fallback did not.
- Formula with several isomers: first match is the most common (seed order),
  the rest come back as `alternatives`.

## Testing

Vitest for the pure modules (formula parsing, Hill order, molar mass, library
matching, balancer, lattice atom counts, SVG projection sanity). Server and
MCP get request level tests through Hono's `app.request`. The client is
verified by loading it in a browser.
