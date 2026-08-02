import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.password_reset_tokens` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'password_reset_tokens' })
export class PasswordResetTokensEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ name: 'token_hash', type: 'text' })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'text' })
  expiresAt!: string;

  @Column({ name: 'used_at', type: 'text', nullable: true })
  usedAt!: string | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

export type PasswordResetTokens = Readonly<PasswordResetTokensEntity>;
