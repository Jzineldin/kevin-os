/**
 * Palette data-source helper — server-side loader for entity rows used by
 * the Command Palette (03-06 Task 2). Called from the route handler at
 * /api/palette-entities so the browser component can stay client-only +
 * fetch via the kos_session cookie (middleware gate).
 *
 * The entity list is fetched once per session on first palette open (see
 * CommandPalette.tsx), then cached in component state. If the
 * dashboard-api endpoint isn't yet implemented, we return an empty array
 * so the palette still works for Views + Actions.
 */
import { z } from 'zod';
import { callApi } from '@/lib/dashboard-api';

export const PaletteEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  bolag: z.string().nullable(),
});

export type PaletteEntity = z.infer<typeof PaletteEntitySchema>;

const EntityListSchema = z.object({
  entities: z.array(PaletteEntitySchema),
});

export async function getPaletteEntities(): Promise<PaletteEntity[]> {
  try {
    const res = await callApi(
      '/entities/list',
      { method: 'GET' },
      EntityListSchema,
    );
    return res.entities;
  } catch {
    return [];
  }
}
