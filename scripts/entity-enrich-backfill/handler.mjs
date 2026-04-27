// One-shot entity enrichment backfill.
// Loads every entity_index row for Kevin, aggregates mentions + emails,
// calls Sonnet 4.6 to infer {relationship, role, org} as structured JSON,
// updates entity_index. Idempotent: skips rows where relationship is
// already set to something other than 'unknown' AND role is non-null
// (operator-curated values take precedence).
//
// Runbook: scripts/entity-enrich-backfill/README.md
// DO NOT deploy as long-lived. Create → invoke → delete (same pattern
// as scripts/admin-wipe-lambda/).

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

const OWNER_ID = "7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c";
const MODEL = "eu.anthropic.claude-sonnet-4-6";

let cachedSecret = null;
const sm = new SecretsManagerClient({ region: "eu-north-1" });
const bedrock = new AnthropicBedrock({ awsRegion: "eu-north-1" });

async function connect() {
  if (!cachedSecret) {
    const s = await sm.send(
      new GetSecretValueCommand({ SecretId: process.env.MASTER_SECRET_ID }),
    );
    cachedSecret = JSON.parse(s.SecretString);
  }
  const client = new pg.Client({
    host: cachedSecret.host,
    port: cachedSecret.port,
    user: cachedSecret.username,
    password: cachedSecret.password,
    database: cachedSecret.dbname,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  return client;
}

async function loadEntities(client, onlyBackfilled) {
  const res = await client.query(
    `
    SELECT id::text AS id, name, type, relationship, role, org,
           seed_context, confidence
    FROM entity_index
    WHERE owner_id = $1::uuid
      ${onlyBackfilled ? "AND 'backfill:agent_runs' = ANY(source)" : ""}
    ORDER BY last_touch DESC NULLS LAST
    `,
    [OWNER_ID],
  );
  return res.rows;
}

async function loadMentions(client, entityId) {
  const res = await client.query(
    `SELECT context, source, occurred_at
     FROM mention_events
     WHERE owner_id = $1::uuid AND entity_id = $2::uuid
     ORDER BY occurred_at DESC
     LIMIT 20`,
    [OWNER_ID, entityId],
  );
  return res.rows;
}

async function loadRelatedEmails(client, entityName) {
  const q = `%${entityName.toLowerCase()}%`;
  const res = await client.query(
    `SELECT from_email,
            COALESCE(subject, '') AS subject,
            received_at,
            COALESCE(body_preview, LEFT(body_plain, 300), '') AS preview
     FROM email_drafts
     WHERE owner_id = $1::uuid
       AND (lower(from_email) LIKE $2
            OR lower(COALESCE(subject, '')) LIKE $2
            OR lower(COALESCE(body_preview, '')) LIKE $2)
     ORDER BY received_at DESC
     LIMIT 5`,
    [OWNER_ID, q],
  );
  return res.rows;
}

function buildCorpus(entity, mentions, emails) {
  const out = [];
  out.push(`<entity>`);
  out.push(`Name: ${entity.name}`);
  out.push(`Current type in index: ${entity.type}`);
  if (entity.seed_context) out.push(`Seed context: ${entity.seed_context}`);
  out.push(`</entity>`);
  if (mentions.length) {
    out.push(`\n<mentions count=${mentions.length}>`);
    for (const m of mentions) {
      out.push(
        `[${m.source} ${m.occurred_at.toISOString().slice(0, 10)}] ${(m.context ?? "").slice(0, 300)}`,
      );
    }
    out.push(`</mentions>`);
  }
  if (emails.length) {
    out.push(`\n<emails count=${emails.length}>`);
    for (const e of emails) {
      out.push(
        `[${e.received_at.toISOString().slice(0, 10)} from=${e.from_email}] ${e.subject.slice(0, 100)} — ${(e.preview ?? "").slice(0, 200)}`,
      );
    }
    out.push(`</emails>`);
  }
  return out.join("\n");
}

const SYSTEM_PROMPT = `You are the KOS Entity Enricher. Given a corpus of raw signal about ONE entity in Kevin's world, infer structured metadata:

- relationship (one of): advisor, co-founder, collaborator, investor, client, partner, vendor, mentor, friend, family, employee, contractor, applicant, team, unknown
- role: short free-text role/title, 2-5 words max. Examples: "CTO Outbehaving", "Angel investor", "Jurist Marcus avtal", "Finance advisor Tale Forge". Empty string if unknowable.
- org: the company/organization they're affiliated with, if clear from the corpus. Examples: "Almi Invest", "Storytel", "Science Park". Empty string if unknowable or if the entity IS itself a company.
- confidence: 0-100 integer reflecting how confident you are in the above. Use 0 if you're just guessing.

# Rules
1. Ground every classification in the corpus. If the corpus doesn't support a value, set it to unknown/empty.
2. For entities where type='organization' (companies, projects, institutions), relationship should generally be 'vendor' / 'partner' / 'client' / 'investor' as it relates to Kevin's businesses. Org field should be EMPTY (the entity IS the org).
3. For entities where the corpus is thin (1-2 mentions with no context), set confidence ≤ 30.
4. Swedish and English are equally valid.
5. DO NOT hallucinate roles. If you can't tell, confidence=0 and empty role.

# Output
Call tool 'record_entity_metadata' EXACTLY ONCE with the four fields.`;

const TOOL_DEF = {
  name: "record_entity_metadata",
  description:
    "Record inferred relationship, role, org, and confidence for one entity based on the provided corpus.",
  input_schema: {
    type: "object",
    properties: {
      relationship: {
        type: "string",
        enum: [
          "advisor",
          "co-founder",
          "collaborator",
          "investor",
          "client",
          "partner",
          "vendor",
          "mentor",
          "friend",
          "family",
          "employee",
          "contractor",
          "applicant",
          "team",
          "unknown",
        ],
      },
      role: { type: "string", maxLength: 80 },
      org: { type: "string", maxLength: 80 },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
    },
    required: ["relationship", "role", "org", "confidence"],
  },
};

async function enrichOne(entity, mentions, emails) {
  const corpus = buildCorpus(entity, mentions, emails);
  const res = await bedrock.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    tools: [TOOL_DEF],
    tool_choice: { type: "tool", name: "record_entity_metadata" },
    messages: [
      { role: "user", content: `Classify this entity based on the corpus:\n\n${corpus}` },
    ],
  });
  for (const block of res.content) {
    if (block.type === "tool_use" && block.name === "record_entity_metadata") {
      return block.input;
    }
  }
  return null;
}

async function writeEnrichment(client, entityId, inferred, priorValues) {
  // Normalise empties
  const relationship =
    inferred.relationship && inferred.relationship !== "unknown"
      ? inferred.relationship
      : priorValues.relationship ?? "unknown";
  const role = inferred.role && inferred.role.trim() ? inferred.role.trim() : priorValues.role ?? null;
  const org = inferred.org && inferred.org.trim() ? inferred.org.trim() : priorValues.org ?? null;
  const confidence = Math.max(Number(inferred.confidence) || 0, priorValues.confidence ?? 0);
  await client.query(
    `UPDATE entity_index
       SET relationship = $2,
           role = $3,
           org = $4,
           confidence = $5,
           updated_at = now()
     WHERE owner_id = $1::uuid AND id = $6::uuid`,
    [OWNER_ID, relationship, role, org, confidence, entityId],
  );
  // Audit — event_log (dashboard_api INSERT grant already covers this role;
  // but kos_admin has full access, so this works regardless).
  await client.query(
    `INSERT INTO event_log (owner_id, kind, actor, occurred_at, detail)
     VALUES ($1::uuid, 'kos-enrich:entity-metadata', 'kos-admin', now(), $2::jsonb)`,
    [
      OWNER_ID,
      JSON.stringify({
        entity_id: entityId,
        relationship,
        role,
        org,
        confidence,
        from_inferred: inferred,
      }),
    ],
  );
}

export const handler = async (event) => {
  const client = await connect();
  const onlyBackfilled = event?.only_backfilled !== false; // default true
  try {
    const entities = await loadEntities(client, onlyBackfilled);
    const results = { total: entities.length, enriched: 0, skipped: 0, errors: [] };
    for (const e of entities) {
      // Skip if operator already curated (confidence > 50 + relationship != unknown)
      if (
        (e.confidence ?? 0) > 50 &&
        e.relationship &&
        e.relationship !== "unknown"
      ) {
        results.skipped++;
        continue;
      }
      try {
        const mentions = await loadMentions(client, e.id);
        const emails = await loadRelatedEmails(client, e.name);
        const inferred = await enrichOne(e, mentions, emails);
        if (!inferred) {
          results.errors.push({ id: e.id, name: e.name, error: "no_tool_use" });
          continue;
        }
        await writeEnrichment(client, e.id, inferred, {
          relationship: e.relationship,
          role: e.role,
          org: e.org,
          confidence: e.confidence,
        });
        results.enriched++;
      } catch (err) {
        results.errors.push({
          id: e.id,
          name: e.name,
          error: String(err.message ?? err).slice(0, 200),
        });
      }
    }
    return results;
  } finally {
    await client.end();
  }
};
