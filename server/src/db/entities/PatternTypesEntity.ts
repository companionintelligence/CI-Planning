import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.pattern_types` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'pattern_types' })
export class PatternTypesEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text', nullable: true })
  ownerId!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'icon_shape', type: 'text' })
  iconShape!: string;

  @Column({ name: 'reminder_config', type: 'text', nullable: true })
  reminderConfig!: string | null;

  @Column({ name: 'is_builtin', type: 'int', nullable: true })
  isBuiltin!: number | null;

  @Column({ name: 'color_token', type: 'text', nullable: true })
  colorToken!: string | null;

  @Column({ type: 'text', nullable: true })
  texture!: string | null;

  @Column({ name: 'default_est_minutes', type: 'int', nullable: true })
  defaultEstMinutes!: number | null;

  @Column({ type: 'int', nullable: true })
  notify!: number | null;

  @Column({ name: 'catch_all', type: 'int' })
  catchAll!: number;
}

export type PatternTypes = Readonly<PatternTypesEntity>;
