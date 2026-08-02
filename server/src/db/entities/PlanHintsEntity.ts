import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.plan_hints` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'plan_hints' })
export class PlanHintsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  date!: string;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'text' })
  tag!: string;

  @Column({ type: 'text', nullable: true })
  time!: string | null;

  @Column({ name: 'created_at', type: 'text', nullable: true })
  createdAt!: string | null;
}

export type PlanHints = Readonly<PlanHintsEntity>;
