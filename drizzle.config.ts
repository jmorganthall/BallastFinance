import { defineConfig } from 'drizzle-kit'

function requireUrl(): string {
  // Migrations run as the database OWNER, not as the restricted app role.
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'Set DATABASE_MIGRATION_URL (preferred) or DATABASE_URL before running drizzle-kit.',
    )
  }
  return url
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // No fallback credential. A default like postgres://user:pass@localhost is
    // the kind of thing that silently "works" against the wrong database, and
    // it reads as a committed credential to anyone auditing the repository.
    url: requireUrl(),
  },
  strict: true,
  verbose: true,
})
