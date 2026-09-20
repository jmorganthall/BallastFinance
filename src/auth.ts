/**
 * Authentication (PRD §2).
 *
 * The app is a standard OIDC client. Google is the only configured provider at
 * launch, but nothing below knows that beyond one import: identity lives in the
 * IdP, and household membership is an app-domain table. Adding or swapping a
 * provider is a config change, not a tenancy change.
 *
 * No password is ever stored. A user is keyed by (issuer, subject) from the ID
 * token; email and display name are cached only so the UI has something to show.
 */

import NextAuth, { type DefaultSession } from 'next-auth'
import Google from 'next-auth/providers/google'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { allowedEmails, householdMembers, users } from '@/db/schema'

declare module 'next-auth' {
  interface Session {
    user: DefaultSession['user'] & {
      id: string
      householdId: string | null
    }
  }
}

const GOOGLE_ISSUER = 'https://accounts.google.com'

/**
 * Resolve an authenticated identity to a household, creating the user row on
 * first sign-in. Returns null when the email is not on the allowlist, which is
 * what gates signup in v1.
 */
export async function resolveMembership(input: {
  issuer: string
  subject: string
  email: string
  displayName?: string | null
}): Promise<{ userId: string; householdId: string } | null> {
  const email = input.email.toLowerCase().trim()

  const [allowed] = await db.select().from(allowedEmails).where(eq(allowedEmails.email, email))
  if (!allowed) return null

  const [existing] = await db
    .select()
    .from(users)
    .where(and(eq(users.issuer, input.issuer), eq(users.subject, input.subject)))

  let userId: string
  if (existing) {
    userId = existing.id
    // Keep the cached display fields current without touching identity.
    const displayName = input.displayName ?? null
    if (existing.email !== email || existing.displayName !== displayName) {
      await db.update(users).set({ email, displayName }).where(eq(users.id, userId))
    }
  } else {
    const [created] = await db
      .insert(users)
      .values({
        issuer: input.issuer,
        subject: input.subject,
        email,
        displayName: input.displayName ?? null,
      })
      .returning({ id: users.id })
    if (!created) return null
    userId = created.id
  }

  const [membership] = await db
    .select()
    .from(householdMembers)
    .where(
      and(
        eq(householdMembers.userId, userId),
        eq(householdMembers.householdId, allowed.householdId),
      ),
    )

  if (!membership) {
    await db
      .insert(householdMembers)
      .values({ userId, householdId: allowed.householdId })
      .onConflictDoNothing()
  }

  return { userId, householdId: allowed.householdId }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  session: {
    strategy: 'jwt',
    // A check-in that demands a fresh sign-in is a check-in that does not
    // happen. Thirty days keeps the habit loop alive on a phone PWA (PRD §2).
    maxAge: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  pages: { signIn: '/sign-in', error: '/sign-in' },
  callbacks: {
    async signIn({ profile }) {
      if (!profile?.email) return false
      const membership = await resolveMembership({
        issuer: GOOGLE_ISSUER,
        subject: String(profile.sub),
        email: profile.email,
        displayName: profile.name ?? null,
      })
      // Not on the allowlist: refused, with no row written anywhere.
      return membership !== null
    },

    async jwt({ token, profile }) {
      if (profile?.email) {
        const membership = await resolveMembership({
          issuer: GOOGLE_ISSUER,
          subject: String(profile.sub),
          email: profile.email,
          displayName: profile.name ?? null,
        })
        if (membership) {
          token.userId = membership.userId
          token.householdId = membership.householdId
        }
      }
      return token
    },

    async session({ session, token }) {
      session.user.id = String(token.userId ?? '')
      session.user.householdId = (token.householdId as string | undefined) ?? null
      return session
    },
  },
})
