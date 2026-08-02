import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.reflections` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'reflections' })
export class ReflectionsEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ type: 'text' })
  kind!: string;

  @PrimaryColumn({ name: 'period_key', type: 'text' })
  periodKey!: string;

  @PrimaryColumn({ type: 'int' })
  position!: number;

  @Column({ type: 'text' })
  body!: string;

  @Column({ name: 'category_id', type: 'text', nullable: true })
  categoryId!: string | null;

  @Column({ name: 'done_at', type: 'text', nullable: true })
  doneAt!: string | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ name: 'updated_at', type: 'text' })
  updatedAt!: string;

  @Column({ name: 'source_kind', type: 'text' })
  sourceKind!: string;

  @Column({ name: 'source_ref', type: 'text', nullable: true })
  sourceRef!: string | null;
}

export type Reflections = Readonly<ReflectionsEntity>;
