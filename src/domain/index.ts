/**
 * The derivation module: the only place math lives (PRD §10).
 *
 * Pure functions over stored facts. No database, no clock, no environment.
 * The UI, the scheduled jobs and the API all call through here; nothing
 * recomputes an accrual for itself.
 */
export * from './dates'
export * from './money'
export * from './recurrence'
export * from './types'
export * from './accrual'
export * from './rollup'
export * from './intake'
export * from './instructions'
export * from './closeout'
export * from './shortfall'
export * from './allocation'
export * from './debt'
export * from './debt-form'
export * from './sheet-import'
export * from './optimizer'
export * from './reshuffle'
export * from './spread'
export * from './equity'
export * from './market-rate'
export * from './trip'
export * from './trip-plan'
