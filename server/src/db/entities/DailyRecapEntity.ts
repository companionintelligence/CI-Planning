import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.daily_recap` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'daily_recap' })
export class DailyRecapEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ type: 'text' })
  date!: string;

  @Column({ type: 'text', nullable: true })
  prose!: string | null;

  @Column({ type: 'text', nullable: true })
  stats!: string | null;

  @Column({ type: 'text', nullable: true })
  focus!: string | null;

  @Column({ type: 'int', nullable: true })
  llm!: number | null;

  @Column({ name: 'inputs_hash', type: 'text', nullable: true })
  inputsHash!: string | null;

  @Column({ name: 'star_objective', type: 'int', nullable: true })
  starObjective!: number | null;

  @Column({ name: 'star_habits', type: 'int', nullable: true })
  starHabits!: number | null;

  @Column({ name: 'star_tasks', type: 'int', nullable: true })
  starTasks!: number | null;

  @Column({ name: 'star_bonus', type: 'int', nullable: true })
  starBonus!: number | null;

  @Column({ name: 'star_note', type: 'int', nullable: true })
  starNote!: number | null;

  @Column({ type: 'int', nullable: true })
  total!: number | null;

  @Column({ name: 'frozen_at', type: 'text', nullable: true })
  frozenAt!: string | null;

  @Column({ name: 'created_at', type: 'text', nullable: true })
  createdAt!: string | null;

  @Column({ name: 'updated_at', type: 'text', nullable: true })
  updatedAt!: string | null;
}

export type DailyRecap = Readonly<DailyRecapEntity>;
