import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.auth_states` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'auth_states' })
export class AuthStatesEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  state!: string;

  @Column({ name: 'code_verifier', type: 'text' })
  codeVerifier!: string;

  @Column({ type: 'text' })
  nonce!: string;

  @Column({ name: 'redirect_uri', type: 'text', nullable: true })
  redirectUri!: string | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ name: 'expires_at', type: 'text' })
  expiresAt!: string;
}

export type AuthStates = Readonly<AuthStatesEntity>;
