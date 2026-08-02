import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.tag_categories` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'tag_categories' })
export class TagCategoriesEntity {
  @PrimaryColumn({ name: 'intention_tag_id', type: 'text' })
  intentionTagId!: string;

  @PrimaryColumn({ name: 'category_tag_id', type: 'text' })
  categoryTagId!: string;
}

export type TagCategories = Readonly<TagCategoriesEntity>;
