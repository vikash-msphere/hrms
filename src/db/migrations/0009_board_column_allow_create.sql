-- A board column now says whether new tasks may be created straight into it (`allowCreate` in the stored
-- columns JSON, domain/boards.ts), off unless turned on, and a board needs at least one column that allows it.
-- Every board saved before the setting existed gets it on its FIRST column, which is where a task filed without
-- naming a column has always landed, and off everywhere else. Data-only; a board whose columns already carry
-- the key is left alone, and a database with no boards is untouched.
UPDATE `boards`
SET `columns_json` = json_set(`columns_json`, '$[0].allowCreate', json('true'))
WHERE json_valid(`columns_json`)
  AND json_array_length(`columns_json`) > 0
  AND NOT EXISTS (SELECT 1 FROM json_each(`boards`.`columns_json`) WHERE json_type(`value`, '$.allowCreate') IS NOT NULL);
