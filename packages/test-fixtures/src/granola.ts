/**
 * Synthetic Granola transcript fixture (Phase 6 Plan 06-00 Task 2).
 *
 * Used by transcript-extractor + granola-poller unit tests to validate
 * `TranscriptAvailable` event handling without hitting Notion live.
 *
 * Default body is a 5-paragraph Swedish-English meeting transcript ~3000
 * chars long with mentions of "Damien", "Almi Invest", "konvertibellån",
 * "Tale Forge" — the canonical Phase 6 mention-set per 06-CONTEXT
 * "Active Threads" reference.
 */
import type { TranscriptAvailable } from '@kos/contracts/context';

export interface GranolaTranscriptOverrides {
  capture_id?: string;
  owner_id?: string;
  transcript_id?: string;
  notion_page_id?: string;
  title?: string | null;
  source?: 'granola';
  last_edited_time?: string;
  raw_length?: number;
}

const DEFAULT_OWNER_ID = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';
const DEFAULT_NOTION_PAGE_ID = '01a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';

/**
 * Synthetic Swedish-English Granola transcript body (~3000 chars).
 * Mentions Damien, Almi Invest, konvertibellån, Tale Forge for entity-resolver
 * coverage. Exported so consumers can use it for downstream extractor tests.
 */
export const GRANOLA_TRANSCRIPT_BODY = `Möte med Damien om Almi Invest och konvertibellån — 2026-04-20

[00:00] Kevin: Hej Damien, tack för att du tog dig tiden idag. Jag ville gå igenom var vi står med Almi Invest och nästa steg på konvertibellånet. Emma Burman skickade ett utkast på avtalet igår och Marcus håller på att läsa igenom det. Vi har bolagsstämma planerad till nästa fredag för att godkänna villkoren.

[02:14] Damien: Sounds great. On the Outbehaving side, Simon and I pushed the new website redesign live this morning. The investor-facing landing page is finally aligned with the brand voice we agreed on. Did you get a chance to look at it?

[04:32] Kevin: Ja, jag tittade på det imorse. Looks really clean. One thing I noticed — the "About" section still references the old company structure. We should update that before we send the link to Almi. Speed Capital also asked for a refreshed deck for their internal committee, so let's make sure both versions are consistent.

[07:51] Damien: Good catch. I'll have Simon push a fix for the About section by Wednesday. On Speed Capital — Fredrik mentioned they want to see traction numbers from Tale Forge before they finalize their term sheet. Are the Q1 numbers ready to share?

[10:08] Kevin: De är nästan klara. Christina Loh erbjöd sig precis att hjälpa till med finance advisory för 6 månader, så hon hjälper Marcus att sätta ihop en cleaner deck för Q1. Hon har bra erfarenhet från Lovable-folket — Javier Soltero, Anton Osika, Sophia Nabil. OpenClaw network är ett bra fönster för oss.

[13:42] Damien: Perfect. Let's lock in the konvertibellån timeline first — bolagsstämma next Friday, signed by EOM, then we move to Speed Capital's term sheet review the week after. I'll sync with Marcus today on the legal side. Anything else blocking from your end?

[15:28] Kevin: Inget akut. Skolpilot Q2 är på väg — Sara Hvit och Monika Björklund leder den. Jag tar action items från det här mötet och lägger in dem i Command Center. Ses nästa onsdag på sync:en.

[16:45] Damien: Awesome, talk soon.

Action items:
- Kevin: Update About section copy for Outbehaving website (deadline: onsdag)
- Damien: Sync with Marcus on konvertibellån legal review
- Kevin: Share Q1 Tale Forge traction numbers with Speed Capital via Christina
- Both: Confirm bolagsstämma agenda for Almi konvertibellån (fredag)`;

/**
 * Build a deterministic synthetic `TranscriptAvailable` event detail.
 * Matches the `TranscriptAvailableSchema` Zod shape in @kos/contracts/context.
 */
export function fakeGranolaTranscript(
  overrides: GranolaTranscriptOverrides = {},
): TranscriptAvailable {
  return {
    capture_id: overrides.capture_id ?? '01HXY5K8AGJ4M7P6Q9R2T3V8WZ',
    owner_id: overrides.owner_id ?? DEFAULT_OWNER_ID,
    transcript_id: overrides.transcript_id ?? DEFAULT_NOTION_PAGE_ID,
    notion_page_id: overrides.notion_page_id ?? DEFAULT_NOTION_PAGE_ID,
    title: overrides.title ?? 'Möte med Damien om Almi och konvertibellån',
    source: overrides.source ?? 'granola',
    last_edited_time: overrides.last_edited_time ?? '2026-04-20T14:30:00.000Z',
    raw_length: overrides.raw_length ?? GRANOLA_TRANSCRIPT_BODY.length,
  };
}
