export function configuredSecretValues(names: readonly string[], environment: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(names
    .map((name) => environment[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

export function redactText(value: string, secretValues: readonly string[]): string {
  return secretValues.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), value);
}
