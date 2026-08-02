import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.pattern_day_optouts` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'pattern_day_optouts' })
export class PatternDayOptoutsEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ name: 'pattern_id', type: 'text' })
  patternId!: string;

  @PrimaryColumn({ type: 'text' })
  date!: string;
}

export type PatternDayOptouts = Readonly<PatternDayOptoutsEntity>;
