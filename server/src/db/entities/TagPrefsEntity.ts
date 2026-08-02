import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.tag_prefs` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'tag_prefs' })
export class TagPrefsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ name: 'tag_id', type: 'text' })
  tagId!: string;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ name: 'auto_fill', type: 'int', nullable: true })
  autoFill!: number | null;

  @Column({ name: 'reminder_offsets', type: 'text', nullable: true })
  reminderOffsets!: string | null;

  @Column({ name: 'icon_shape', type: 'text', nullable: true })
  iconShape!: string | null;

  @Column({ name: 'color_token', type: 'text' })
  colorToken!: string;

  @Column({ name: 'default_minutes', type: 'int' })
  defaultMinutes!: number;
}

export type TagPrefs = Readonly<TagPrefsEntity>;
