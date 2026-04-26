/**
 * Phase 5 Plan 05-00 — sample fazer-ai/baileys-api webhook envelopes used
 * by services/baileys-sidecar tests.
 *
 * `baileysIncomingTextEnvelope` is a 1:1 text message;
 * `baileysIncomingVoiceEnvelope` is a push-to-talk audio message (ptt:true,
 * `audio/ogg; codecs=opus`). Both shapes mirror the
 * `messages.upsert` event the Fargate container emits when Baileys sees
 * traffic on the WhatsApp WebSocket.
 *
 * The enclosing `data.type === 'notify'` distinguishes new messages from
 * older `append`/`replace` event types; the sidecar only routes `notify`.
 */
export const baileysIncomingTextEnvelope = {
  event: 'messages.upsert',
  data: {
    messages: [
      {
        key: {
          remoteJid: '46700000000@s.whatsapp.net',
          fromMe: false,
          id: '3A0000000000000000',
        },
        messageTimestamp: 1713832345,
        pushName: 'Damien',
        message: { conversation: 'Hey Kevin, check this out' },
      },
    ],
    type: 'notify',
  },
} as const;

export const baileysIncomingVoiceEnvelope = {
  event: 'messages.upsert',
  data: {
    messages: [
      {
        key: {
          remoteJid: '46700000000@s.whatsapp.net',
          fromMe: false,
          id: '3A0000000000000001',
        },
        messageTimestamp: 1713832346,
        pushName: 'Damien',
        message: {
          audioMessage: {
            url: 'https://mmg.whatsapp.net/path/to/opus',
            mimetype: 'audio/ogg; codecs=opus',
            seconds: 17,
            ptt: true,
          },
        },
      },
    ],
    type: 'notify',
  },
} as const;
