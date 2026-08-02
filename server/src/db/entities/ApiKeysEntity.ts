import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.api_keys` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'api_keys' })
export class ApiKeysEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  prefix!: string;

  @Column({ name: 'key_hash', type: 'text' })
  keyHash!: string;

  @Column({ type: 'text' })
  scopes!: string;

  @Column({ name: 'expires_at', type: 'text', nullable: true })
  expiresAt!: string | null;

  @Column({ name: 'last_used_at', type: 'text', nullable: true })
  lastUsedAt!: string | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ name: 'revoked_at', type: 'text', nullable: true })
  revokedAt!: string | null;
}

export type ApiKeys = Readonly<ApiKeysEntity>;
