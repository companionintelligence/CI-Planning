import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.sync_events` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'sync_events' })
export class SyncEventsEntity {
  @PrimaryColumn({ type: 'int' })
  seq!: number;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  entity!: string;

  @Column({ name: 'entity_id', type: 'text' })
  entityId!: string;

  @Column({ type: 'int', nullable: true })
  version!: number | null;

  @Column({ type: 'text' })
  event!: string;

  @Column({ type: 'text' })
  payload!: string;

  @Column({ type: 'text' })
  at!: string;
}

export type SyncEvents = Readonly<SyncEventsEntity>;
