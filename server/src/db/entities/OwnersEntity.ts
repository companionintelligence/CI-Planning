import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.owners` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'owners' })
export class OwnersEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ name: 'last_auto_run_id', type: 'text', nullable: true })
  lastAutoRunId!: string | null;

  @Column({ name: 'external_subject', type: 'text', nullable: true })
  externalSubject!: string | null;

  @Column({ type: 'text', nullable: true })
  username!: string | null;

  @Column({ name: 'password_hash', type: 'text', nullable: true })
  passwordHash!: string | null;

  @Column({ name: 'backup_email', type: 'text', nullable: true })
  backupEmail!: string | null;

  @Column({ name: 'session_epoch', type: 'int' })
  sessionEpoch!: number;

  @Column({ type: 'text' })
  role!: string;
}

export type Owners = Readonly<OwnersEntity>;
