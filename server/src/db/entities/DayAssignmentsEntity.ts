import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.day_assignments` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'day_assignments' })
export class DayAssignmentsEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ type: 'text' })
  date!: string;

  @Column({ name: 'day_type_key', type: 'text' })
  dayTypeKey!: string;
}

export type DayAssignments = Readonly<DayAssignmentsEntity>;
