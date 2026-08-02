import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.entity_categories` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'entity_categories' })
export class EntityCategoriesEntity {
  @PrimaryColumn({ name: 'entity_kind', type: 'text' })
  entityKind!: string;

  @PrimaryColumn({ name: 'entity_id', type: 'text' })
  entityId!: string;

  @PrimaryColumn({ name: 'category_tag_id', type: 'text' })
  categoryTagId!: string;

  @Column({ type: 'int' })
  position!: number;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

export type EntityCategories = Readonly<EntityCategoriesEntity>;
