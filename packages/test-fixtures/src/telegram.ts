/**
 * Telegram Bot API Update payload factories for tests.
 *
 * Shapes match Bot API 8.x; used by services/telegram-bot unit tests plus
 * any downstream service that verifies CAP-01 event structures.
 */
export function makeTelegramTextUpdate(text: string, fromId = 111222333): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: 'private' },
      from: { id: fromId, is_bot: false, first_name: 'Kevin' },
      text,
    },
  };
}

export function makeTelegramVoiceUpdate(fileId = 'voice-abc', fromId = 111222333): unknown {
  return {
    update_id: 2,
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: 'private' },
      from: { id: fromId, is_bot: false, first_name: 'Kevin' },
      voice: {
        file_id: fileId,
        file_unique_id: 'u1',
        duration: 8,
        mime_type: 'audio/ogg',
      },
    },
  };
}
