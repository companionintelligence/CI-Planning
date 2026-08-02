import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.replan_suggestions` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'replan_suggestions' })
export class ReplanSuggestionsEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  date!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'text' })
  summary!: string;

  @Column({ name: 'at_risk', type: 'int' })
  atRisk!: number;

  @Column({ name: 'created_at', type: 'text', nullable: true })
  createdAt!: string | null;
}

export type ReplanSuggestions = Readonly<ReplanSuggestionsEntity>;
