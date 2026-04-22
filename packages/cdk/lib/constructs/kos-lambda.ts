import type { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IVpc, SubnetSelection, ISecurityGroup } from 'aws-cdk-lib/aws-ec2';

export interface KosLambdaProps {
  /** Path to the TypeScript entry file (e.g. `path.join(__dirname, '../handlers/foo/index.ts')`). */
  entry: string;
  /** Exported handler name. Defaults to `handler`. */
  handler?: string;
  /** Function timeout. Defaults to 30 seconds. */
  timeout?: Duration;
  /** Memory in MB. Defaults to 512. */
  memory?: number;
  /** Extra environment variables. Merged with KOS defaults (NODE_OPTIONS, TZ). */
  environment?: Record<string, string>;
  /** VPC to place the function in (only for functions that reach RDS). Omit for external-API callers per D-05. */
  vpc?: IVpc;
  /** Which subnets to run in. Required when `vpc` is set. */
  vpcSubnets?: SubnetSelection;
  /** Security groups for the ENI. Required when `vpc` is set. */
  securityGroups?: ISecurityGroup[];
}

/**
 * KosLambda — shared NodejsFunction wrapper encoding KOS-wide Lambda defaults:
 *
 * - Node.js 22.x runtime on ARM_64 (Graviton, ~20% cheaper than x86_64 at same perf)
 * - esbuild bundling with `@aws-sdk/*` externalized (runtime-provided in Node 22.x → <2MB zip)
 * - Source maps enabled via `NODE_OPTIONS=--enable-source-maps`
 * - TZ explicitly set to UTC — Stockholm math is done in code via `Intl.DateTimeFormat`,
 *   NOT via `TZ=Europe/Stockholm` env var (see RESEARCH §Anti-Patterns line 263)
 * - CloudWatch log retention = 30 days (CLAUDE.md cost constraint)
 * - VPC placement is explicit (no default) per D-05 threat mitigation T-01-01
 *
 * All Phase 1 Lambdas (notion-indexer, push-telegram, azure-bootstrap,
 * transcribe-vocab-deploy, backfill) use this construct.
 */
export class KosLambda extends NodejsFunction {
  constructor(scope: Construct, id: string, props: KosLambdaProps) {
    super(scope, id, {
      entry: props.entry,
      handler: props.handler ?? 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: props.timeout ?? Duration.seconds(30),
      memorySize: props.memory ?? 512,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        TZ: 'UTC', // explicit UTC — Stockholm math done in code via Intl
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
        format: OutputFormat.ESM,
        // Shim CommonJS `require` inside ESM output. Without this, libraries
        // that internally call `require('http')`/`require('https')` (e.g.
        // grammY) crash at Lambda INIT with
        // "Error: Dynamic require of \"http\" is not supported".
        banner:
          "import{createRequire}from'module';const require=createRequire(import.meta.url);",
      },
      logRetention: RetentionDays.ONE_MONTH,
      vpc: props.vpc,
      vpcSubnets: props.vpcSubnets,
      securityGroups: props.securityGroups,
    });
  }
}
