/**
 * A resort as a first-class fact (D64): the tier ladders, the name match,
 * and the seed list in migration 0032 read back as the domain sees it.
 * The 31 names below are resortings.com's own spellings, read from its
 * prices-by-month page (updated Nov 11, 2026) on Nov 28, 2026.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canonicalStay,
  normaliseResortName,
  parseResort,
  resolveResort,
  ResortError,
  tierWords,
  unmatchedNames,
  validateResort,
  type Resort,
  type ResortAlias,
} from '../resort'

const RESORTINGS_NAMES = [
  'The Villas at Grand Floridian Resort & Spa',
  'Grand Floridian Resort & Spa',
  'Polynesian Village Resort',
  'Bay Lake Tower at Contemporary Resort',
  'BoardWalk Inn',
  'BoardWalk Villas',
  'Beach Club Villas',
  'Beach Club Resort',
  'Yacht Club Resort',
  'Contemporary Resort',
  'Boulder Ridge Villas at Wilderness Lodge',
  'Wilderness Lodge',
  'Copper Creek Villas & Cabins at Wilderness Lodge',
  'Polynesian Villas & Bungalows',
  'Riviera Resort',
  'Lakeshore Lodge',
  'Animal Kingdom Lodge',
  'Animal Kingdom Villas - Kidani Village',
  'Old Key West Resort',
  'Saratoga Springs Resort & Spa',
  'Animal Kingdom Villas - Jambo House',
  'Caribbean Beach Resort',
  'Port Orleans Resort - Riverside',
  'Port Orleans Resort - French Quarter',
  'Coronado Springs Resort',
  'Art of Animation Resort',
  'Pop Century Resort',
  'All-Star Music Resort',
  'All-Star Movies Resort',
  'All-Star Sports Resort',
  'The Campsites at Fort Wilderness Resort',
]

/** The seed in migration 0032, read from the SQL itself so the test and the migration cannot drift apart. */
function seeded(): { resorts: Resort[]; aliases: ResortAlias[] } {
  const sql = readFileSync(new URL('../../../drizzle/0032_resorts_and_raw_pulls.sql', import.meta.url), 'utf8')
  const unquote = (v: string) => v.slice(1, -1).replace(/''/g, "'")
  const resorts = [...sql.matchAll(/\(('[^']+'), '(wdw|uor)', '(disney|universal)', ('(?:[^']|'')+'), '([a-z_]+)', (true|false)\)/g)].map((m) =>
    parseResort({ id: unquote(m[1]!), destination: m[2], brand: m[3], name: unquote(m[4]!), tier: m[5], dvc: m[6] === 'true' }),
  )
  const aliases = [...sql.matchAll(/\('(any|[a-z_]+)', ('(?:[^']|'')+'), '([a-z0-9-]+)'\)/g)].map((m) => ({ source: m[1]!, alias: unquote(m[2]!), resortId: m[3]! }))
  return { resorts, aliases }
}

describe('the resort list (migration 0032)', () => {
  const catalogue = seeded()

  it('holds every Disney resort resortings.com prices, the Fort Wilderness cabins, and Universal\'s 11 hotels', () => {
    expect(catalogue.resorts.filter((r) => r.brand === 'disney')).toHaveLength(32)
    expect(catalogue.resorts.filter((r) => r.brand === 'universal')).toHaveLength(11)
    expect(new Set(catalogue.resorts.map((r) => r.id)).size).toBe(43)
  })

  it('places each of resortings.com\'s 31 names on exactly one resort', () => {
    const placed = RESORTINGS_NAMES.map((n) => resolveResort('resortings', n, catalogue)?.id)
    expect(placed.every((id) => id !== undefined)).toBe(true)
    expect(new Set(placed).size).toBe(31)
    expect(unmatchedNames('resortings', RESORTINGS_NAMES, catalogue)).toEqual([])
  })

  it('never gives two resorts the same normalised name', () => {
    const keys = catalogue.resorts.map((r) => normaliseResortName(r.name))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('places a DVC broker\'s spellings', () => {
    expect(resolveResort('dvc_rental_store', "Disney's Polynesian Villas", catalogue)?.id).toBe('wdw-polynesian-villas')
    expect(resolveResort('dvc_rental_store', 'Beach Club Villas', catalogue)?.id).toBe('wdw-beach-club-villas')
  })

  it('puts Express Unlimited on no hotel the domain does not know', () => {
    const sql = readFileSync(new URL('../../../drizzle/0032_resorts_and_raw_pulls.sql', import.meta.url), 'utf8')
    const perkIds = [...sql.matchAll(/\('(uor-[a-z-]+)', 'express_unlimited'/g)].map((m) => m[1])
    expect(perkIds.sort()).toEqual(['uor-hard-rock', 'uor-portofino-bay', 'uor-royal-pacific'])
    expect(perkIds.every((id) => catalogue.resorts.some((r) => r.id === id && r.tier === 'signature'))).toBe(true)
  })

  it('keeps the villas deluxe with dvc set, so Disney\'s three published tiers still cover them', () => {
    const villas = catalogue.resorts.filter((r) => r.dvc)
    expect(villas).toHaveLength(14)
    expect(villas.every((r) => r.tier === 'deluxe' && r.brand === 'disney')).toBe(true)
  })
})

describe('matching a name', () => {
  const pop: Resort = { id: 'wdw-pop-century', destination: 'wdw', brand: 'disney', name: "Disney's Pop Century Resort", tier: 'value', dvc: false }
  const aoa: Resort = { id: 'wdw-art-of-animation', destination: 'wdw', brand: 'disney', name: "Disney's Art of Animation Resort", tier: 'value', dvc: false }
  const catalogue = { resorts: [pop, aoa], aliases: [{ source: 'some_broker', alias: 'POP', resortId: 'wdw-pop-century' }] }

  it('reads past the owner\'s prefix, "Resort", "&", dashes, curly quotes and case', () => {
    expect(normaliseResortName("Disney’s Port Orleans Resort – French Quarter")).toBe(normaliseResortName('Port Orleans Resort - French Quarter'))
    expect(normaliseResortName('Saratoga Springs Resort & Spa')).toBe('saratoga springs and spa')
    expect(resolveResort('typed', 'pop century', catalogue)?.id).toBe('wdw-pop-century')
  })

  it('uses an alias only for its own source, or for any source', () => {
    expect(resolveResort('some_broker', 'POP', catalogue)?.id).toBe('wdw-pop-century')
    expect(resolveResort('another', 'POP', catalogue)).toBeNull()
  })

  it('leaves a name nothing matches unmatched rather than guessing', () => {
    expect(resolveResort('typed', 'Pop', catalogue)).toBeNull()
    expect(unmatchedNames('typed', ['Pop', 'all', 'tier:value', 'Art of Animation'], catalogue)).toEqual(['Pop'])
  })

  it('refuses when two resorts share a name, rather than pick one', () => {
    const twin = { ...aoa, id: 'wdw-pop-twin', name: 'Pop Century Resort' }
    expect(() => resolveResort('typed', 'Pop Century', { resorts: [pop, twin], aliases: [] })).toThrow(ResortError)
  })

  it('gives a stay its canonical key', () => {
    expect(canonicalStay('all', 'x', catalogue)).toBe('all')
    expect(canonicalStay('tier:value', 'x', catalogue)).toBe('tier:value')
    expect(canonicalStay(' Pop Century ', 'typed', catalogue)).toBe('resort:wdw-pop-century')
    expect(canonicalStay('Somewhere New', 'typed', catalogue)).toBe('Somewhere New')
  })
})

describe('a resort\'s own rules', () => {
  const base: Resort = { id: 'uor-cabana-bay', destination: 'uor', brand: 'universal', name: 'Universal Cabana Bay Beach Resort', tier: 'value', dvc: false }

  it('holds a tier to its brand\'s ladder', () => {
    expect(() => validateResort(base)).not.toThrow()
    expect(() => validateResort({ ...base, tier: 'moderate' })).toThrow(ResortError)
    expect(() => validateResort({ ...base, brand: 'disney' })).toThrow(ResortError)
    expect(() => validateResort({ ...base, dvc: true })).toThrow(ResortError)
    expect(() => validateResort({ ...base, id: 'Cabana Bay' })).toThrow(ResortError)
  })

  it('says each brand\'s tiers in its own words', () => {
    expect(tierWords('universal', 'signature')).toBe('Signature Collection')
    expect(tierWords('disney', 'campground')).toBe('Campground')
  })

  it('refuses a stored row that is not a resort', () => {
    expect(() => parseResort({ ...base, tier: 'luxury' })).toThrow()
    expect(() => parseResort({ ...base, destination: 'dlr' })).toThrow()
  })
})
