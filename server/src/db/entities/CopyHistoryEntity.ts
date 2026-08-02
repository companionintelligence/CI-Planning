import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.copy_history` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'copy_history' })
export class CopyHistoryEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  surface!: string;

  @Column({ type: 'text' })
  signature!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

export type CopyHistory = Readonly<CopyHistoryEntity>;
