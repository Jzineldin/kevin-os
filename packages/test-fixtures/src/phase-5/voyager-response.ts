/**
 * Phase 5 Plan 05-00 — sample LinkedIn Voyager API responses used by
 * apps/chrome-extension/src/content-linkedin.ts unit tests.
 *
 * `voyagerConversationsResponse` mirrors the GET /voyager/api/messaging/
 * conversations payload (paged list of conversations).
 *
 * `voyagerThreadEventsResponse` mirrors the per-conversation thread events
 * GET — one MessageEvent per element. Both shapes are the public Voyager
 * envelope (subject to LinkedIn-side change without notice — Plan 05-03
 * locks the parsing surface to these two endpoints).
 */
export const voyagerConversationsResponse = {
  elements: [
    {
      entityUrn: 'urn:li:fs_conversation:2-AAAAAAAA',
      lastActivityAt: 1713832345678,
      participants: [
        {
          miniProfile: {
            firstName: 'Damien',
            lastName: 'Hateley',
            publicIdentifier: 'damien-hateley',
          },
        },
      ],
      messages: { '*elements': ['urn:li:fs_event:(2-AAAAAAAA,5-BBBBBBBB)'] },
    },
  ],
  paging: { start: 0, count: 20, total: 127 },
} as const;

export const voyagerThreadEventsResponse = {
  elements: [
    {
      entityUrn: 'urn:li:fs_event:(2-AAAAAAAA,5-BBBBBBBB)',
      createdAt: 1713832345678,
      from: {
        messagingMember: {
          miniProfile: {
            firstName: 'Damien',
            lastName: 'Hateley',
            publicIdentifier: 'damien-hateley',
          },
        },
      },
      eventContent: {
        'com.linkedin.voyager.messaging.event.MessageEvent': {
          body: { text: 'Yo Kevin, saw your deck — can we jump on a call?' },
        },
      },
    },
  ],
  paging: { start: 0, count: 20, total: 42 },
} as const;
