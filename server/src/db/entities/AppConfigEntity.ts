import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.app_config` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'app_config' })
export class AppConfigEntity {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'text' })
  value!: string;

  @Column({ name: 'updated_at', type: 'text' })
  updatedAt!: string;
}

export type AppConfig = Readonly<AppConfigEntity>;
