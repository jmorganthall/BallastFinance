/**
 * Notifications (PRD §8).
 *
 * The app owns all computation; n8n owns delivery. Everything here does is post
 * a fully-formed, already-decided payload to one webhook, and n8n routes it to
 * text or email. Keeping the logic on this side means channels can change
 * without an app release, and it means there is exactly one place where a
 * notification's wording is decided.
 *
 * A failed delivery is logged and swallowed: a notification that cannot be sent
 * must never take down the scheduled job that computed it, and never roll back a
 * user's write.
 */

export type NotificationKind =
  | 'weekly_digest'
  | 'due_date_prompt'
  | 'check_in_nudge'
  | 'promo_expiry_warning'
  | 'lifestyle_second_half'

export interface NotificationPayload {
  kind: NotificationKind
  householdId: string
  /** A one-line summary suitable for an SMS, already in plain language. */
  summary: string
  /** Longer body for email. Markdown. */
  body: string
  /** Deep link to the exact confirmation screen (PRD §8). */
  link: string
  /** Structured detail, in case a future n8n flow wants to format its own. */
  detail?: unknown
}

export async function sendNotification(payload: NotificationPayload): Promise<boolean> {
  const url = process.env.N8N_WEBHOOK_URL
  if (!url) {
    console.warn(`[notify] N8N_WEBHOOK_URL not set; dropping "${payload.kind}"`)
    return false
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.N8N_WEBHOOK_TOKEN
          ? { authorization: `Bearer ${process.env.N8N_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      console.error(`[notify] ${payload.kind} rejected: HTTP ${response.status}`)
      return false
    }
    return true
  } catch (error) {
    console.error(`[notify] ${payload.kind} failed to send:`, error)
    return false
  }
}
