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

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('load'), query: z.string().min(1), sceneId: z.string().optional(), newScene: z.boolean().optional() }),
  z.object({ type: z.literal('set_structure'), smiles: z.string().optional(), molfile: z.string().optional(), name: z.string().optional(), baseVersion: z.number().int().optional() }),
  z.object({ type: z.literal('set_view'), view: ViewPatchSchema, sceneId: z.string().optional() }),
  z.object({ type: z.literal('focus'), speciesId: z.string() }),
  z.object({ type: z.literal('new_scene'), title: z.string().optional(), query: z.string().optional() }),
  z.object({ type: z.literal('close_scene'), sceneId: z.string() }),
  z.object({ type: z.literal('switch_scene'), sceneId: z.string() }),
  z.object({ type: z.literal('rename_scene'), sceneId: z.string(), title: z.string().min(1) }),
]);
export type Command = z.infer<typeof CommandSchema>;
