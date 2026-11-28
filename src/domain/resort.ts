/**
 * A resort is a first-class fact (D64, proposed): the one thing a Disney
 * rate, a quote, a DVC listing and a stay perk are about, at Walt Disney
 * World or Universal Orlando.
 *
 * Three layers, so a better parser, a better match or a new screen never
 * changes what was received (D64 (1), the household's medallion rule):
 *
 *   raw      source_pulls: each page or paste exactly as it arrived,
 *            append-only (source-pull.ts)
 *   facts    resorts, resort_aliases, resort_perks, and the rates,
 *            quotes and listings. A fact keeps the source's own name for
 *            a resort beside nothing else: which resort it is about is
 *            worked out, never stored
 *   derived  which resort a name means (resolveResort), a stay's
 *            canonical key (canonicalStay), and every price label and
 *            prediction built on them. Never a column
 *
 * Each brand has its own tier ladder, as each sells it (D64 (2)). Disney's
 * villas are deluxe with dvc set, matching the three tiers Disney's
 * published rates are averaged over. Universal's ladder is its own three
 * groups. A tier is never compared across brands.
 *
 * A name is matched by its normalised spelling only: exactly, then by an
 * alias kept for that source, then by an alias for any source. There is no
 * fuzzy matching: a name nothing matches stays unmatched and says so,
 * because a wrong guess would price one resort at another's rate.
 *
 * Nothing here is stored and nothing here does I/O.
 */

import { z } from 'zod'
import type { Destination } from './trip'

export type Brand = 'disney' | 'universal'

export const BRAND_OF_DESTINATION: Record<Destination, Brand> = { wdw: 'disney', uor: 'universal' }

/**
 * Disney's ladder. `campground` is the Fort Wilderness campsites, which
 * Disney prices on their own and resortings.com leaves out of the three
 * tier averages' names; it is never folded into value or moderate.
 */
export type DisneyTier = 'value' | 'moderate' | 'deluxe' | 'campground'
/** Universal's three groups: Value Inns and Suites, Prime Value Hotels, Signature Collection. */
export type UniversalTier = 'value' | 'prime_value' | 'signature'
export type ResortTier = DisneyTier | UniversalTier

export const TIERS: { readonly disney: readonly DisneyTier[]; readonly universal: readonly UniversalTier[] } = {
  disney: ['value', 'moderate', 'deluxe', 'campground'],
  universal: ['value', 'prime_value', 'signature'],
}

const TIER_WORDS: Record<Brand, Record<string, string>> = {
  disney: { value: 'Value', moderate: 'Moderate', deluxe: 'Deluxe', campground: 'Campground' },
  universal: { value: 'Value Inns and Suites', prime_value: 'Prime Value', signature: 'Signature Collection' },
}

export interface Resort {
  /** A stable slug, e.g. "wdw-pop-century". */
  id: string
  destination: Destination
  brand: Brand
  /** The owner's own name for it, e.g. "Disney's Pop Century Resort". */
  name: string
  tier: ResortTier
  /** A Disney Vacation Club resort: its rooms can be rented with points. Always false at Universal. */
  dvc: boolean
}

/** Any source: an alias kept under this applies to every source's spelling. */
export const ANY_SOURCE = 'any'

/** Another spelling of a resort's name, as one source writes it. */
export interface ResortAlias {
  source: string
  /** As the source writes it; matched normalised. */
  alias: string
  resortId: string
}

export type ResortPerkKind = 'express_unlimited'

export const PERK_WORDS: Record<ResortPerkKind, string> = {
  express_unlimited: 'Universal Express Unlimited included',
}

/**
 * A perk a resort's guests get, as a source said it on a date. It is an
 * observation, not a promise: a perk older than the trip's booking is
 * checked again, like any dated fact.
 */
export interface ResortPerk {
  resortId: string
  perk: ResortPerkKind
  /** What it covers, in the source's terms, e.g. which parks. */
  detail: string
  source: string
  sourceUrl: string
  observedOn: string
}

export class ResortError extends Error {}

const ResortRow = z.object({
  id: z.string(),
  destination: z.enum(['wdw', 'uor']),
  brand: z.enum(['disney', 'universal']),
  name: z.string(),
  tier: z.enum(['value', 'moderate', 'deluxe', 'campground', 'prime_value', 'signature']),
  dvc: z.boolean(),
})

const PerkRow = z.object({
  resortId: z.string(),
  perk: z.enum(['express_unlimited']),
  detail: z.string(),
  source: z.string(),
  sourceUrl: z.string(),
  observedOn: z.string(),
})

/** A stored resort read back: parsed, then held to its brand's ladder. */
export function parseResort(row: unknown): Resort {
  const resort: Resort = ResortRow.parse(row)
  validateResort(resort)
  return resort
}

/** A stored perk read back, parsed. */
export function parseResortPerk(row: unknown): ResortPerk {
  return PerkRow.parse(row)
}

export function tierWords(brand: Brand, tier: ResortTier): string {
  return TIER_WORDS[brand][tier] ?? tier
}

/** A resort's tier belongs to its brand's ladder, its brand to its destination, and only Disney has DVC. */
export function validateResort(r: Resort): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id)) throw new ResortError(`A resort's id is a lower-case slug, not "${r.id}".`)
  if (!r.name.trim()) throw new ResortError('A resort needs a name.')
  if (BRAND_OF_DESTINATION[r.destination] !== r.brand) throw new ResortError(`${r.name} is at ${r.destination}, which is not ${r.brand}'s.`)
  if (!(TIERS[r.brand] as readonly string[]).includes(r.tier)) throw new ResortError(`${r.tier} is not a ${r.brand} tier.`)
  if (r.dvc && r.brand !== 'disney') throw new ResortError('Only a Disney resort can be a DVC resort.')
}

/**
 * A name reduced to what tells two resorts apart: lower case, the owner's
 * prefix dropped wherever it stands ("Disney's", "Disney", "Universal",
 * "Loews"), the words "Resort" and "Hotel" and a leading "The" dropped,
 * "&" read as "and", every dash and punctuation mark a space, and spaces
 * collapsed. "The Villas at Disney's Grand Floridian Resort & Spa" and
 * "Villas at Grand Floridian Resort & Spa" are the same, and so are "Pop
 * Century" and "Disney's Pop Century Resort".
 */
export function normaliseResortName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/\b(disney's|disney|universal's|universal|loews)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(resort|hotel)\b/g, ' ')
    .replace(/^\s*the\b/, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Which resort a source's name means, or null when nothing matches:
 * the resort's own name, then an alias kept for that source, then one for
 * any source. Two resorts sharing a normalised name is a catalogue error,
 * and refuses rather than picks.
 */
export function resolveResort(
  source: string,
  name: string,
  catalogue: { resorts: readonly Resort[]; aliases: readonly ResortAlias[] },
): Resort | null {
  const key = normaliseResortName(name)
  if (key === '') return null
  const byId = new Map(catalogue.resorts.map((r) => [r.id, r]))
  const pick = (ids: string[]): Resort | null => {
    const unique = [...new Set(ids)]
    if (unique.length > 1) throw new ResortError(`"${name}" could be ${unique.join(' or ')}; the resort list needs fixing.`)
    return unique.length === 1 ? (byId.get(unique[0]!) ?? null) : null
  }
  const own = pick(catalogue.resorts.filter((r) => normaliseResortName(r.name) === key).map((r) => r.id))
  if (own) return own
  for (const from of [source, ANY_SOURCE]) {
    const hit = pick(catalogue.aliases.filter((a) => a.source === from && normaliseResortName(a.alias) === key).map((a) => a.resortId))
    if (hit) return hit
  }
  return null
}

/**
 * A stay key as the ladder compares it: "all" and "tier:<tier>" stand as
 * they are; any other key is a resort's name, which becomes
 * "resort:<id>" when the catalogue knows it and stays the trimmed name
 * when it does not. Two keys that mean the same resort compare equal, so
 * a quote typed as "Pop Century" meets Disney's rate for "Pop Century
 * Resort".
 */
export function canonicalStay(
  key: string,
  source: string,
  catalogue: { resorts: readonly Resort[]; aliases: readonly ResortAlias[] },
): string {
  const k = key.trim()
  if (k === 'all' || k.startsWith('tier:') || k.startsWith('resort:')) return k
  const resort = resolveResort(source, k, catalogue)
  return resort ? `resort:${resort.id}` : k
}

/** The names a source used that the catalogue cannot place, each once, for the screen and the PR's to-do list. */
export function unmatchedNames(
  source: string,
  names: readonly string[],
  catalogue: { resorts: readonly Resort[]; aliases: readonly ResortAlias[] },
): string[] {
  const out = new Set<string>()
  for (const n of names) {
    const k = n.trim()
    if (k === '' || k === 'all' || k.startsWith('tier:')) continue
    if (!resolveResort(source, k, catalogue)) out.add(k)
  }
  return [...out].sort()
}
