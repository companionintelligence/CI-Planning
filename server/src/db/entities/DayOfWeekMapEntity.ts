import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.day_of_week_map` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'day_of_week_map' })
export class DayOfWeekMapEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ type: 'int' })
  dow!: number;

  @Column({ name: 'day_type_key', type: 'text' })
  dayTypeKey!: string;
}

export type DayOfWeekMap = Readonly<DayOfWeekMapEntity>;
