import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.patterns` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'patterns' })
export class PatternsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text', nullable: true })
  ownerId!: string | null;

  @Column({ name: 'type_id', type: 'text', nullable: true })
  typeId!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  tag!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ name: 'created_at', type: 'text', nullable: true })
  createdAt!: string | null;

  @Column({ name: 'recurrence_rule', type: 'text', nullable: true })
  recurrenceRule!: string | null;

  @Column({ name: 'recurrence_dtstart', type: 'text', nullable: true })
  recurrenceDtstart!: string | null;

  @Column({ name: 'color_token', type: 'text', nullable: true })
  colorToken!: string | null;
}

export type Patterns = Readonly<PatternsEntity>;
