/**
 * Synthetic entity fixtures for resolver tests.
 *
 * - Damien Lovell has aliases that exercise pg_trgm similarity (Damien → Damian typo)
 * - Henrik Norén has 'our CTO' alias to exercise semantic-only cosine match
 */
export const damienEntity = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Damien Lovell',
  aliases: ['Damien', 'Dam'],
  linkedProjects: ['proj-taleforge'],
  type: 'Person',
};

export const henrikEntity = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Henrik Norén',
  aliases: ['Henrik', 'CTO', 'our CTO'],
  linkedProjects: ['proj-taleforge'],
  type: 'Person',
};
