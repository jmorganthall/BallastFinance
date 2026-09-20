/**
 * The derivation module: the only place math lives (PRD §10).
 *
 * Pure functions over stored facts. No database, no clock, no environment.
 * The UI, the scheduled jobs and the API all call through here; nothing
 * recomputes an accrual for itself.
 */
export * from './dates'
export * from './money'
export * from './types'
export * from './accrual'
export * from './rollup'
export * from './intake'
export * from './instructions'
export * from './closeout'
export * from './allocation'
export * from './debt'
export * from './optimizer'
