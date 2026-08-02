import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.planning_sessions` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'planning_sessions' })
export class PlanningSessionsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ name: 'started_at', type: 'text' })
  startedAt!: string;

  @Column({ name: 'ended_at', type: 'text', nullable: true })
  endedAt!: string | null;

  @Column({ name: 'entry_branch', type: 'text' })
  entryBranch!: string;

  @Column({ type: 'text' })
  status!: string;

  @Column({ name: 'llm_used', type: 'int' })
  llmUsed!: number;

  @Column({ type: 'text' })
  transcript!: string;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

export type PlanningSessions = Readonly<PlanningSessionsEntity>;
