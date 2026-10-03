CREATE TABLE catalogs (
    catalog_id TEXT PRIMARY KEY,
    registered_at TEXT,
    mazes_json TEXT
);

INSERT INTO catalogs (catalog_id, registered_at, mazes_json)
VALUES ('catalog-9c11b007456847a4946a69e28b179de28eaef730377df09baf9bfba1eb7bbb28', '1970-01-01T00:00:00.000Z', '[{"maze_id":"maze_04x04_adjacent_01","tier":"1","width":4,"height":4,"relation":"adjacent"},{"maze_id":"maze_04x04_adjacent_02","tier":"1","width":4,"height":4,"relation":"adjacent"},{"maze_id":"maze_04x04_opposite_03","tier":"1","width":4,"height":4,"relation":"opposite"},{"maze_id":"maze_04x04_opposite_04","tier":"1","width":4,"height":4,"relation":"opposite"},{"maze_id":"maze_04x04_same_05","tier":"1","width":4,"height":4,"relation":"same"},{"maze_id":"maze_06x06_adjacent_01","tier":"1","width":6,"height":6,"relation":"adjacent"},{"maze_id":"maze_06x06_adjacent_02","tier":"1","width":6,"height":6,"relation":"adjacent"},{"maze_id":"maze_06x06_opposite_03","tier":"1","width":6,"height":6,"relation":"opposite"},{"maze_id":"maze_06x06_opposite_04","tier":"1","width":6,"height":6,"relation":"opposite"},{"maze_id":"maze_06x06_same_05","tier":"1","width":6,"height":6,"relation":"same"},{"maze_id":"maze_09x09_adjacent_01","tier":"1","width":9,"height":9,"relation":"adjacent"},{"maze_id":"maze_09x09_adjacent_02","tier":"1","width":9,"height":9,"relation":"adjacent"},{"maze_id":"maze_09x09_opposite_03","tier":"1","width":9,"height":9,"relation":"opposite"},{"maze_id":"maze_09x09_opposite_04","tier":"1","width":9,"height":9,"relation":"opposite"},{"maze_id":"maze_09x09_same_05","tier":"1","width":9,"height":9,"relation":"same"},{"maze_id":"maze_12x12_adjacent_01","tier":"1","width":12,"height":12,"relation":"adjacent"},{"maze_id":"maze_12x12_adjacent_02","tier":"1","width":12,"height":12,"relation":"adjacent"},{"maze_id":"maze_12x12_opposite_03","tier":"1","width":12,"height":12,"relation":"opposite"},{"maze_id":"maze_12x12_opposite_04","tier":"1","width":12,"height":12,"relation":"opposite"},{"maze_id":"maze_12x12_same_05","tier":"1","width":12,"height":12,"relation":"same"},{"maze_id":"maze_15x15_adjacent_01","tier":"1","width":15,"height":15,"relation":"adjacent"},{"maze_id":"maze_15x15_adjacent_02","tier":"1","width":15,"height":15,"relation":"adjacent"},{"maze_id":"maze_15x15_opposite_03","tier":"1","width":15,"height":15,"relation":"opposite"},{"maze_id":"maze_15x15_opposite_04","tier":"1","width":15,"height":15,"relation":"opposite"},{"maze_id":"maze_15x15_same_05","tier":"1","width":15,"height":15,"relation":"same"},{"maze_id":"maze_18x18_adjacent_01","tier":"1","width":18,"height":18,"relation":"adjacent"},{"maze_id":"maze_18x18_adjacent_02","tier":"1","width":18,"height":18,"relation":"adjacent"},{"maze_id":"maze_18x18_opposite_03","tier":"1","width":18,"height":18,"relation":"opposite"},{"maze_id":"maze_18x18_opposite_04","tier":"1","width":18,"height":18,"relation":"opposite"},{"maze_id":"maze_18x18_same_05","tier":"1","width":18,"height":18,"relation":"same"},{"maze_id":"maze_t2_15x15_adjacent_01","tier":"2","width":15,"height":15,"relation":"adjacent"},{"maze_id":"maze_t2_15x15_adjacent_02","tier":"2","width":15,"height":15,"relation":"adjacent"},{"maze_id":"maze_t2_15x15_opposite_03","tier":"2","width":15,"height":15,"relation":"opposite"},{"maze_id":"maze_t2_15x15_opposite_04","tier":"2","width":15,"height":15,"relation":"opposite"},{"maze_id":"maze_t2_15x15_same_05","tier":"2","width":15,"height":15,"relation":"same"},{"maze_id":"maze_t2_18x18_adjacent_01","tier":"2","width":18,"height":18,"relation":"adjacent"},{"maze_id":"maze_t2_18x18_adjacent_02","tier":"2","width":18,"height":18,"relation":"adjacent"},{"maze_id":"maze_t2_18x18_opposite_03","tier":"2","width":18,"height":18,"relation":"opposite"},{"maze_id":"maze_t2_18x18_opposite_04","tier":"2","width":18,"height":18,"relation":"opposite"},{"maze_id":"maze_t2_18x18_same_05","tier":"2","width":18,"height":18,"relation":"same"},{"maze_id":"maze_t2_21x21_adjacent_01","tier":"2","width":21,"height":21,"relation":"adjacent"},{"maze_id":"maze_t2_21x21_adjacent_02","tier":"2","width":21,"height":21,"relation":"adjacent"},{"maze_id":"maze_t2_21x21_opposite_03","tier":"2","width":21,"height":21,"relation":"opposite"},{"maze_id":"maze_t2_21x21_opposite_04","tier":"2","width":21,"height":21,"relation":"opposite"},{"maze_id":"maze_t2_21x21_same_05","tier":"2","width":21,"height":21,"relation":"same"},{"maze_id":"maze_t2_24x24_adjacent_01","tier":"2","width":24,"height":24,"relation":"adjacent"},{"maze_id":"maze_t2_24x24_adjacent_02","tier":"2","width":24,"height":24,"relation":"adjacent"},{"maze_id":"maze_t2_24x24_opposite_03","tier":"2","width":24,"height":24,"relation":"opposite"},{"maze_id":"maze_t2_24x24_opposite_04","tier":"2","width":24,"height":24,"relation":"opposite"},{"maze_id":"maze_t2_24x24_same_05","tier":"2","width":24,"height":24,"relation":"same"}]');

ALTER TABLE attempts ADD COLUMN catalog_id TEXT NOT NULL DEFAULT 'catalog-9c11b007456847a4946a69e28b179de28eaef730377df09baf9bfba1eb7bbb28';

CREATE TABLE attempt_starts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts (id),
    browser_id TEXT NOT NULL,
    maze_id TEXT NOT NULL,
    tier INTEGER NOT NULL,
    catalog_id TEXT NOT NULL REFERENCES catalogs (catalog_id),
    started_at TEXT NOT NULL
);

INSERT INTO attempt_starts (attempt_id, browser_id, maze_id, tier, catalog_id, started_at)
SELECT id, browser_id, maze_id, tier, catalog_id, started_at
FROM attempts
ORDER BY started_at, rowid;

CREATE TRIGGER attempts_record_start
AFTER INSERT ON attempts
BEGIN
    INSERT INTO attempt_starts (attempt_id, browser_id, maze_id, tier, catalog_id, started_at)
    VALUES (NEW.id, NEW.browser_id, NEW.maze_id, NEW.tier, NEW.catalog_id, NEW.started_at);
END;

CREATE TRIGGER attempt_starts_are_immutable
BEFORE UPDATE ON attempt_starts
BEGIN
    SELECT RAISE(ABORT, 'attempt starts are immutable');
END;

CREATE TRIGGER attempt_starts_cannot_be_deleted
BEFORE DELETE ON attempt_starts
BEGIN
    SELECT RAISE(ABORT, 'attempt starts cannot be deleted');
END;
