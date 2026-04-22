/**
 * Shallow mock of @notionhq/client. Each method records its arguments into
 * `calls.*` and returns a minimal, deterministic response.
 *
 * Used by voice-capture, entity-resolver, and bulk-import-* unit tests to
 * verify Notion-first writes without hitting the live API.
 */
export interface MockNotionCalls {
  pagesCreate: unknown[];
  databasesQuery: unknown[];
  databasesRetrieve: unknown[];
}

export interface MockNotionClient {
  calls: MockNotionCalls;
  pages: {
    create: (args: unknown) => Promise<{ id: string; url: string }>;
  };
  databases: {
    query: (args: unknown) => Promise<{
      results: unknown[];
      has_more: boolean;
      next_cursor: null;
    }>;
    retrieve: (args: unknown) => Promise<{ id: string; properties: Record<string, unknown> }>;
  };
}

export function mockNotionClient(): MockNotionClient {
  const calls: MockNotionCalls = {
    pagesCreate: [],
    databasesQuery: [],
    databasesRetrieve: [],
  };
  return {
    calls,
    pages: {
      create: async (args) => {
        calls.pagesCreate.push(args);
        return { id: 'mock-page-id', url: 'https://notion.so/mock' };
      },
    },
    databases: {
      query: async (args) => {
        calls.databasesQuery.push(args);
        return { results: [], has_more: false, next_cursor: null };
      },
      retrieve: async (args) => {
        calls.databasesRetrieve.push(args);
        return { id: 'mock-db', properties: {} };
      },
    },
  };
}
