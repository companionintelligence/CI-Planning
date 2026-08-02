-- migrate:up
CREATE TABLE planning.will_not_exist (id text PRIMARY KEY);
SELECT this_function_does_not_exist();
-- migrate:down
DROP TABLE planning.will_not_exist;
