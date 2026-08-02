import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.oauth_states` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'oauth_states' })
export class OauthStatesEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  provider!: string;

  @Column({ type: 'text' })
  state!: string;

  @Column({ name: 'code_verifier', type: 'text' })
  codeVerifier!: string;

  @Column({ type: 'text', nullable: true })
  nonce!: string | null;

  @Column({ name: 'redirect_uri', type: 'text', nullable: true })
  redirectUri!: string | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ name: 'expires_at', type: 'text', nullable: true })
  expiresAt!: string | null;
}

export type OauthStates = Readonly<OauthStatesEntity>;
