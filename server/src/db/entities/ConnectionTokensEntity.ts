import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.connection_tokens` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'connection_tokens' })
export class ConnectionTokensEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  provider!: string;

  @Column({ type: 'text' })
  account!: string;

  @Column({ type: 'text' })
  iv!: string;

  @Column({ name: 'auth_tag', type: 'text' })
  authTag!: string;

  @Column({ type: 'text' })
  ciphertext!: string;

  @Column({ name: 'key_version', type: 'int' })
  keyVersion!: number;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ name: 'updated_at', type: 'text' })
  updatedAt!: string;

  @Column({ type: 'text' })
  status!: string;
}

export type ConnectionTokens = Readonly<ConnectionTokensEntity>;
