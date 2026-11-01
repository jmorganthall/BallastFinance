import { describe, expect, it } from 'vitest'
import { planCost } from '../plan-order'
import type { PlanPosition } from '../position'
import type { PackageView } from '../rollup'

const view = { totalCents: 100000 } as PackageView
const plan = (totalCents: number, parts = 1) => ({ totalCents, parts: Array(parts).fill({}) }) as unknown as PlanPosition

describe("what a plan's page says it costs (D57 (2))", () => {
  it('says what is still to have ready once spends have lowered it', () => {
    expect(planCost(view, plan(70000))).toEqual({ allCents: 100000, stillCents: 70000 })
  })

  it('says only what it costs in all when the two agree, or for a draft or a finished plan', () => {
    expect(planCost(view, plan(100000))).toEqual({ allCents: 100000, stillCents: null })
    expect(planCost(view, null)).toEqual({ allCents: 100000, stillCents: null })
    expect(planCost(view, plan(0, 0))).toEqual({ allCents: 100000, stillCents: null })
  })
})
