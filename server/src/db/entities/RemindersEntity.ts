import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.reminders` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'reminders' })
export class RemindersEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ name: 'task_id', type: 'text', nullable: true })
  taskId!: string | null;

  @Column({ name: 'block_id', type: 'text', nullable: true })
  blockId!: string | null;

  @Column({ name: 'fire_at', type: 'text' })
  fireAt!: string;

  @Column({ type: 'text' })
  status!: string;

  @Column({ name: 'fired_at', type: 'text', nullable: true })
  firedAt!: string | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ type: 'text' })
  source!: string;
}

export type Reminders = Readonly<RemindersEntity>;
