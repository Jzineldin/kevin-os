import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});

async function getSecret(arn) {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  return r.SecretString;
}

export const handler = async (event) => {
  const adminSecret = JSON.parse(await getSecret(process.env.ADMIN_DB_SECRET_ARN));
  const newUserSecret = JSON.parse(await getSecret(process.env.NEW_USER_SECRET_ARN));

  const client = new pg.Client({
    host: adminSecret.host,
    port: adminSecret.port,
    user: adminSecret.username,
    password: adminSecret.password,
    database: adminSecret.dbname,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const username = newUserSecret.username;
  const password = newUserSecret.password;
  const log = [];

  // Idempotent create
  const { rows: existing } = await client.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1', [username]
  );

  if (existing.length === 0) {
    await client.query(`CREATE ROLE "${username}" WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`);
    log.push(`Created role ${username}`);
  } else {
    await client.query(`ALTER ROLE "${username}" WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`);
    log.push(`Updated password for ${username}`);
  }

  await client.query(`GRANT CONNECT ON DATABASE kos TO "${username}"`);
  await client.query(`GRANT USAGE ON SCHEMA public TO "${username}"`);

  // Grant SELECT on each table that actually exists
  const tables = ['entity_index', 'mention_events', 'project_index', 'inbox_index', 'top3_membership'];
  const grantLog = [];
  for (const t of tables) {
    const { rows } = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
      [t]
    );
    if (rows.length === 0) {
      grantLog.push(`skipped ${t} (not exists)`);
      continue;
    }
    await client.query(`GRANT SELECT ON ${t} TO "${username}"`);
    grantLog.push(`granted SELECT on ${t}`);
  }
  log.push(...grantLog);

  // Verify
  const { rows: tableGrants } = await client.query(`
    SELECT table_name, privilege_type 
    FROM information_schema.role_table_grants 
    WHERE grantee = $1 
    ORDER BY table_name
  `, [username]);

  // Also grant on RDS Proxy
  // (Proxy pre-created — just needs the user to authenticate)
  
  await client.end();

  return { statusCode: 200, body: { log, tableGrants } };
};
