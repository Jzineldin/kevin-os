// One-shot admin-SQL Lambda.
// Reads a master-DB secret, connects to the RDS instance (NOT the proxy),
// executes wipe.sql as a single multi-statement query inside a transaction,
// returns PRE/DELETE/POST counts for every SELECT/DELETE in the file.
//
// Runbook: scripts/admin-wipe-lambda/README.md
// DO NOT deploy this Lambda long-lived. Create → invoke → delete.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import { readFileSync } from "fs";

export const handler = async (event) => {
  const sm = new SecretsManagerClient({ region: "eu-north-1" });
  const s = await sm.send(
    new GetSecretValueCommand({ SecretId: process.env.MASTER_SECRET_ID })
  );
  const secret = JSON.parse(s.SecretString);
  const sql = readFileSync("./wipe.sql", "utf8");

  const client = new pg.Client({
    host: secret.host,
    port: secret.port,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  await client.connect();
  try {
    const res = await client.query(sql);
    const out = Array.isArray(res)
      ? res.map((r) => ({ command: r.command, rowCount: r.rowCount, rows: r.rows }))
      : [{ command: res.command, rowCount: res.rowCount, rows: res.rows }];
    return { ok: true, results: out };
  } finally {
    await client.end();
  }
};
