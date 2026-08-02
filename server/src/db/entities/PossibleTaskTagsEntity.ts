import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.possible_task_tags` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'possible_task_tags' })
export class PossibleTaskTagsEntity {
  @PrimaryColumn({ name: 'possible_task_id', type: 'text' })
  possibleTaskId!: string;

  @PrimaryColumn({ name: 'tag_id', type: 'text' })
  tagId!: string;
}

export type PossibleTaskTags = Readonly<PossibleTaskTagsEntity>;
