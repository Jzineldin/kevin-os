/**
 * @kos/dashboard-api — in-VPC Lambda behind a Function URL (AWS_IAM auth).
 * Wave 0 scaffold only: routes and handlers land in plans 03-05..03-10.
 */
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

export const handler: APIGatewayProxyHandlerV2 = async () => ({
  statusCode: 501,
  body: JSON.stringify({ error: 'not implemented' }),
  headers: { 'content-type': 'application/json' },
});
