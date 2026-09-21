import { describe, expect, it } from 'vitest'
import { dueUrgency, humanDistance, nextDue } from '../next-due'
import type { LineItemState } from '../types'

const TODAY = '2026-09-21'

function item(id: string, dueDate: string, state: LineItemState = 'accruing') {
  return { id, label: id, dueDate, state }
}

describe('humanDistance', () => {
  it('names today, tomorrow and yesterday outright', () => {
    expect(humanDistance(0)).toBe('today')
    expect(humanDistance(1)).toBe('tomorrow')
    expect(humanDistance(-1)).toBe('yesterday')
  })

  it('counts days under a week', () => {
    expect(humanDistance(2)).toBe('in 2 days')
    expect(humanDistance(6)).toBe('in 6 days')
  })

  it('rounds to weeks under a month', () => {
    expect(humanDistance(7)).toBe('in 1 week')
    expect(humanDistance(10)).toBe('in 1 week')
    expect(humanDistance(11)).toBe('in 2 weeks')
    expect(humanDistance(29)).toBe('in 4 weeks')
  })

  it('rounds to months under a year', () => {
    expect(humanDistance(30)).toBe('in 1 month')
    expect(humanDistance(44)).toBe('in 1 month')
    expect(humanDistance(45)).toBe('in 2 months')
    expect(humanDistance(364)).toBe('in 12 months')
  })

  it('rounds to years from a year out', () => {
    expect(humanDistance(365)).toBe('in 1 year')
    expect(humanDistance(730)).toBe('in 2 years')
  })

  it('says how long ago when it has passed', () => {
    expect(humanDistance(-3)).toBe('3 days ago')
    expect(humanDistance(-21)).toBe('3 weeks ago')
  })
})

describe('dueUrgency', () => {
  it('is soon under 30 days, near from 30 to 60, far beyond', () => {
    expect(dueUrgency(-5)).toBe('soon')
    expect(dueUrgency(0)).toBe('soon')
    expect(dueUrgency(29)).toBe('soon')
    expect(dueUrgency(30)).toBe('near')
    expect(dueUrgency(60)).toBe('near')
    expect(dueUrgency(61)).toBe('far')
    expect(dueUrgency(400)).toBe('far')
  })
})

describe('nextDue', () => {
  it('picks the earliest part that has not been confirmed spent', () => {
    const next = nextDue(
      [item('airfare', '2026-11-21'), item('tickets', '2026-10-17'), item('hotel', '2027-01-16')],
      TODAY,
    )
    expect(next).toMatchObject({
      lineItemId: 'tickets',
      dueDate: '2026-10-17',
      daysAway: 26,
      distance: 'in 4 weeks',
      urgency: 'soon',
    })
  })

  it('skips retired parts', () => {
    const next = nextDue([item('spent', '2026-09-25', 'retired'), item('later', '2026-12-19')], TODAY)
    expect(next?.lineItemId).toBe('later')
    expect(next?.daysAway).toBe(89)
    expect(next?.urgency).toBe('far')
  })

  it('keeps an overdue part as the next thing out, and says it has passed', () => {
    const next = nextDue([item('overdue', '2026-09-18'), item('later', '2026-12-19')], TODAY)
    expect(next).toMatchObject({ lineItemId: 'overdue', daysAway: -3, distance: '3 days ago', urgency: 'soon' })
  })

  it('is null when there is nothing left to come out', () => {
    expect(nextDue([], TODAY)).toBeNull()
    expect(nextDue([item('spent', '2026-09-25', 'retired')], TODAY)).toBeNull()
  })
})
