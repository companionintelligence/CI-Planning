import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.outbound_queue` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'outbound_queue' })
export class OutboundQueueEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ name: 'block_id', type: 'text' })
  blockId!: string;

  @Column({ type: 'text' })
  provider!: string;

  @Column({ type: 'text' })
  account!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

export type OutboundQueue = Readonly<OutboundQueueEntity>;
