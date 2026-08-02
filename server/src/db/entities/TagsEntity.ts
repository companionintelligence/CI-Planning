import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.tags` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'tags' })
export class TagsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'int' })
  muted!: number;

  @Column({ name: 'is_base', type: 'int' })
  isBase!: number;
}

export type Tags = Readonly<TagsEntity>;
