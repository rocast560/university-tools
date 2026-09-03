// zod schemas shared by REST, WebSocket and MCP. Phase 2 adds edit, undo and redo.

import { z } from 'zod';

export const ViewPatchSchema = z.object({
  style: z.enum(['ballstick', 'stick', 'spacefill', 'wireframe']).optional(),
  labels: z.enum(['none', 'element', 'index']).optional(),
  highlight: z.array(z.number().int().min(1)).optional(),
  spin: z.boolean().optional(),
  showDipole: z.boolean().optional(),
  showHydrogens: z.boolean().optional(),
  camera: z.object({
    preset: z.enum(['fit', 'front', 'top', 'side']),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
  }).optional(),
});
export type ViewPatch = z.infer<typeof ViewPatchSchema>;

const atomIndex = z.number().int().min(1);
const bondOrder = z.union([z.literal(1), z.literal(2), z.literal(3)]);

// Upper bounds on caller-supplied text and op counts. Generous enough for real molecules; they exist
// so an AI client or a stray script cannot make the server do unbounded work.
export const MAX_OPS = 50;
const element = z.string().min(1).max(8);
const group = z.string().min(1).max(500);
const smiles = z.string().min(1).max(2000);
const molfile = z.string().min(1).max(200_000);
const query = z.string().min(1).max(200);
const title = z.string().min(1).max(200);

export const EditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_atom'), element, bondTo: atomIndex, order: bondOrder.optional() }),
  z.object({ op: z.literal('remove_atom'), index: atomIndex }),
  z.object({ op: z.literal('set_element'), index: atomIndex, element }),
  z.object({ op: z.literal('set_charge'), index: atomIndex, charge: z.number().int().min(-4).max(4) }),
  z.object({ op: z.literal('add_bond'), a: atomIndex, b: atomIndex, order: bondOrder.optional() }),
  z.object({ op: z.literal('remove_bond'), a: atomIndex, b: atomIndex }),
  z.object({ op: z.literal('set_bond_order'), a: atomIndex, b: atomIndex, order: bondOrder }),
  z.object({ op: z.literal('attach_group'), index: atomIndex, group }),
  z.object({ op: z.literal('replace_group'), index: atomIndex, group }),
]);
export type EditOpInput = z.infer<typeof EditOpSchema>;

/** The same bounded strings, for the MCP tool input schemas. */
export const Bounded = { group, smiles, molfile, query, title };

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('load'), query, sceneId: z.string().optional(), newScene: z.boolean().optional() }),
  z.object({ type: z.literal('set_structure'), smiles: smiles.optional(), molfile: molfile.optional(), name: title.optional(), baseVersion: z.number().int().optional() }),
  z.object({ type: z.literal('set_view'), view: ViewPatchSchema, sceneId: z.string().optional() }),
  z.object({ type: z.literal('focus'), speciesId: z.string() }),
  z.object({ type: z.literal('new_scene'), title: title.optional(), query: query.optional() }),
  z.object({ type: z.literal('close_scene'), sceneId: z.string() }),
  z.object({ type: z.literal('switch_scene'), sceneId: z.string() }),
  z.object({ type: z.literal('rename_scene'), sceneId: z.string(), title }),
  z.object({ type: z.literal('edit'), ops: z.array(EditOpSchema).min(1).max(MAX_OPS), baseVersion: z.number().int().optional(), name: title.optional() }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('redo') }),
]);
export type Command = z.infer<typeof CommandSchema>;
