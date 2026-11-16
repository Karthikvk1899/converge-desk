export function config() {
  const admin = process.env.ADMIN_KEY ?? "";
  if (admin.length < 32)
    throw new Error("ADMIN_KEY requires at least 32 characters");
  const origin = process.env.PUBLIC_ORIGIN ?? "http://localhost:3000";
  const parsed = new URL(origin);
  if (parsed.origin !== origin)
    throw new Error("PUBLIC_ORIGIN must be an origin without a trailing slash");
  return {
    admin,
    origin,
    port: Number(process.env.PORT ?? 8080),
    instance: process.env.INSTANCE_ID ?? "local",
    db:
      process.env.DATABASE_URL ??
      "postgresql://desk:local-dev-only@localhost:5432/desk",
    redis: process.env.REDIS_URL ?? "redis://localhost:6379",
  };
}
