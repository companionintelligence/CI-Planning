import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.sync_state` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'sync_state' })
export class SyncStateEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  provider!: string;

  @Column({ type: 'text' })
  account!: string;

  @Column({ type: 'text' })
  resource!: string;

  @Column({ type: 'text', nullable: true })
  cursor!: string | null;

  @Column({ name: 'updated_at', type: 'text' })
  updatedAt!: string;
}

export type SyncState = Readonly<SyncStateEntity>;
