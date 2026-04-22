import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
  Credentials,
  ParameterGroup,
  StorageType,
} from 'aws-cdk-lib/aws-rds';
import {
  InstanceType,
  InstanceClass,
  InstanceSize,
  SubnetType,
  type IVpc,
  SecurityGroup,
} from 'aws-cdk-lib/aws-ec2';

export interface KosRdsProps {
  vpc: IVpc;
}

/**
 * KosRds — single-AZ db.t4g.medium Postgres 16.x (latest AWS-offered patch) in PRIVATE_ISOLATED subnets.
 *
 * Decisions enforced here:
 *  - D-07: `db.t4g.medium`, single-AZ, 7-day backup retention.
 *  - D-03: `RemovalPolicy.RETAIN` + `deletionProtection: true` — cdk destroy
 *    will never touch the DB, matching archive-not-delete philosophy.
 *  - RESEARCH Pitfall 4: pgvector 0.8.0 requires Postgres 16.5+. AWS deprecates
 *    minor versions over time — originally pinned to VER_16_5, bumped to VER_16_12
 *    on 2026-04-22 after 16.5 was retired in eu-north-1. All 16.6+ versions
 *    support pgvector 0.8.0 (the extension is created post-connect via
 *    `CREATE EXTENSION vector`). VER_16_12 is highest available in aws-cdk-lib
 *    2.248.0; region offers up to 16.13.
 *  - RESEARCH Pattern 3: force SSL via parameter group so `sslmode=require`
 *    client URLs are enforced at server level, not just documented.
 *
 * The construct exposes `securityGroup` so DataStack can surface it to
 * Lambdas (Plan 04+) and so the bastion (Task 3) can add a single ingress
 * rule without reaching into the DatabaseInstance internals.
 */
export class KosRds extends Construct {
  public readonly instance: DatabaseInstance;
  public readonly securityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: KosRdsProps) {
    super(scope, id);

    this.securityGroup = new SecurityGroup(this, 'Sg', {
      vpc: props.vpc,
      description: 'KOS RDS ingress - Lambdas in PRIVATE_ISOLATED only',
      allowAllOutbound: false,
    });

    const engine = DatabaseInstanceEngine.postgres({
      version: PostgresEngineVersion.VER_16_12,
    });
    const parameterGroup = new ParameterGroup(this, 'Pg', {
      engine,
      parameters: {
        'rds.force_ssl': '1',
      },
    });

    this.instance = new DatabaseInstance(this, 'Instance', {
      engine,
      // D-07: db.t4g.medium, single-AZ, revisit post Gate 4.
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      multiAz: false,
      storageType: StorageType.GP3,
      allocatedStorage: 50,
      storageEncrypted: true,
      backupRetention: Duration.days(7),
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
      publiclyAccessible: false,
      credentials: Credentials.fromGeneratedSecret('kos_admin'),
      parameterGroup,
      databaseName: 'kos',
    });
  }
}
