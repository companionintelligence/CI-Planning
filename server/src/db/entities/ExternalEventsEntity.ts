import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.external_events` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'external_events' })
export class ExternalEventsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  provider!: string;

  @Column({ type: 'text' })
  account!: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId!: string;

  @Column({ name: 'block_id', type: 'text', nullable: true })
  blockId!: string | null;

  @Column({ type: 'text', nullable: true })
  etag!: string | null;

  @Column({ type: 'text' })
  direction!: string;

  @Column({ name: 'last_synced_at', type: 'text' })
  lastSyncedAt!: string;
}

export type ExternalEvents = Readonly<ExternalEventsEntity>;
