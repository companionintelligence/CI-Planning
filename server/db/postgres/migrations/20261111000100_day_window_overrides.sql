-- migrate:up
CREATE TABLE planning."day_window_overrides" (
  owner_id text NOT NULL,
  date text NOT NULL,
  direction_tag_id text NOT NULL,
  ranges_json text NOT NULL,
  CONSTRAINT pk_day_window_overrides PRIMARY KEY (owner_id, date, direction_tag_id),
  CONSTRAINT fk_day_window_overrides_owner FOREIGN KEY (owner_id)
    REFERENCES planning."owners" (id) ON DELETE CASCADE,
  CONSTRAINT fk_day_window_overrides_direction FOREIGN KEY (direction_tag_id)
    REFERENCES planning."tags" (id) ON DELETE CASCADE
);
CREATE INDEX ix_day_window_overrides_owner_date
  ON planning."day_window_overrides" (owner_id, date);

-- migrate:down
DROP TABLE IF EXISTS planning."day_window_overrides";
