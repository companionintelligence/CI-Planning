import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.life_priorities` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'life_priorities' })
export class LifePrioritiesEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  category!: string;

  @Column({ type: 'int' })
  satisfaction!: number;

  @Column({ type: 'int' })
  importance!: number;

  @Column({ name: 'target_hours_per_week', type: 'int' })
  targetHoursPerWeek!: number;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ name: 'updated_at', type: 'text' })
  updatedAt!: string;
}

export type LifePriorities = Readonly<LifePrioritiesEntity>;
