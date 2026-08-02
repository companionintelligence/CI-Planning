import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.pattern_blocks` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'pattern_blocks' })
export class PatternBlocksEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ name: 'direction_tag_id', type: 'text' })
  directionTagId!: string;

  @Column({ name: 'day_type', type: 'text' })
  dayType!: string;

  @Column({ name: 'start_time', type: 'text' })
  startTime!: string;

  @Column({ name: 'end_time', type: 'text' })
  endTime!: string;
}

export type PatternBlocks = Readonly<PatternBlocksEntity>;
