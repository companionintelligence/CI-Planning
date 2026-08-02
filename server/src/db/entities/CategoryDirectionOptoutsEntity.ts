import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.category_direction_optouts` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'category_direction_optouts' })
export class CategoryDirectionOptoutsEntity {
  @PrimaryColumn({ name: 'category_tag_id', type: 'text' })
  categoryTagId!: string;

  @PrimaryColumn({ name: 'direction_tag_id', type: 'text' })
  directionTagId!: string;
}

export type CategoryDirectionOptouts = Readonly<CategoryDirectionOptoutsEntity>;
