import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.tag_directions` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'tag_directions' })
export class TagDirectionsEntity {
  @PrimaryColumn({ name: 'intention_tag_id', type: 'text' })
  intentionTagId!: string;

  @PrimaryColumn({ name: 'direction_tag_id', type: 'text' })
  directionTagId!: string;
}

export type TagDirections = Readonly<TagDirectionsEntity>;
