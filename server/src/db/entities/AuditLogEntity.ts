import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.audit_log` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'audit_log' })
export class AuditLogEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  actor!: string;

  @Column({ type: 'text' })
  action!: string;

  @Column({ type: 'text' })
  entity!: string;

  @Column({ type: 'text' })
  at!: string;
}

export type AuditLog = Readonly<AuditLogEntity>;
