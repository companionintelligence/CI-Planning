import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.entity_tags` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'entity_tags' })
export class EntityTagsEntity {
  @PrimaryColumn({ name: 'entity_kind', type: 'text' })
  entityKind!: string;

  @PrimaryColumn({ name: 'entity_id', type: 'text' })
  entityId!: string;

  @PrimaryColumn({ name: 'tag_id', type: 'text' })
  tagId!: string;

  @Column({ type: 'int' })
  level!: number;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

export type EntityTags = Readonly<EntityTagsEntity>;
