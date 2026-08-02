import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.block_templates` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'block_templates' })
export class BlockTemplatesEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text', nullable: true })
  ownerId!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  tag!: string | null;

  @Column({ name: 'default_minutes', type: 'int', nullable: true })
  defaultMinutes!: number | null;

  @Column({ type: 'text', nullable: true })
  tasks!: string | null;
}

export type BlockTemplates = Readonly<BlockTemplatesEntity>;
