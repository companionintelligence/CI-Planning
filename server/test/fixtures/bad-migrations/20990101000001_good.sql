-- migrate:up
CREATE TABLE planning.good_one (id text PRIMARY KEY);
-- migrate:down
DROP TABLE planning.good_one;
