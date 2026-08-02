import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.connection_prefs` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'connection_prefs' })
export class ConnectionPrefsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  provider!: string;

  @Column({ type: 'text' })
  account!: string;

  @Column({ name: 'color_token', type: 'text' })
  colorToken!: string;

  @Column({ type: 'text' })
  texture!: string;
}

export type ConnectionPrefs = Readonly<ConnectionPrefsEntity>;
