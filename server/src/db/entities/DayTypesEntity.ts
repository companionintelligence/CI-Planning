import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.day_types` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'day_types' })
export class DayTypesEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  key!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'is_builtin', type: 'int' })
  isBuiltin!: number;
}

export type DayTypes = Readonly<DayTypesEntity>;
