// Fixture entry used by KosLambda unit tests. The bundler resolves this path at
// synth time; at test time we only assert on the synthesized CloudFormation
// resource properties, so the handler body never actually runs.
export const handler = async () => ({ statusCode: 200 });
