CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    browser_id TEXT NOT NULL,
    maze_id TEXT NOT NULL,
    tier INTEGER NOT NULL CHECK (tier IN (1, 2)),
    status TEXT NOT NULL CHECK (status IN ('active', 'success', 'collision', 'quit')),
    actions_json TEXT NOT NULL DEFAULT '[]',
    command_count INTEGER NOT NULL DEFAULT 0 CHECK (command_count >= 0),
    current_event TEXT NOT NULL DEFAULT 'START_OUT',
    facing TEXT NOT NULL CHECK (facing IN ('N', 'E', 'S', 'W')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    score REAL,
    successful_moves INTEGER,
    remaining_moves INTEGER,
    optimal_moves INTEGER,
    completion_ratio REAL,
    efficiency_ratio REAL,
    UNIQUE (browser_id, maze_id)
);

CREATE UNIQUE INDEX attempts_one_active_per_browser
    ON attempts (browser_id)
    WHERE status = 'active';

CREATE TABLE commands (
    attempt_id TEXT NOT NULL REFERENCES attempts (id),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    request_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('action', 'quit')),
    action TEXT CHECK (action IN ('S', 'B', 'L', 'R')),
    PRIMARY KEY (attempt_id, sequence),
    CHECK ((kind = 'action' AND action IS NOT NULL) OR (kind = 'quit' AND action IS NULL))
);

CREATE TABLE export_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL CHECK (value >= 0)
);

INSERT INTO export_state (id, value) VALUES (1, 0);

CREATE TABLE terminal_exports (
    sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts (id)
);

CREATE TRIGGER attempts_assign_terminal_sequence
AFTER UPDATE OF status ON attempts
WHEN OLD.status = 'active' AND NEW.status IN ('success', 'collision', 'quit')
BEGIN
    UPDATE export_state SET value = value + 1 WHERE id = 1;
    INSERT INTO terminal_exports (sequence, attempt_id)
    SELECT value, NEW.id FROM export_state WHERE id = 1;
END;

CREATE TRIGGER attempts_keep_finished_rows_immutable
BEFORE UPDATE ON attempts
WHEN OLD.status <> 'active'
BEGIN
    SELECT RAISE(ABORT, 'finished attempts are immutable');
END;

CREATE TRIGGER attempts_keep_finished_rows
BEFORE DELETE ON attempts
WHEN OLD.status <> 'active'
BEGIN
    SELECT RAISE(ABORT, 'finished attempts cannot be deleted');
END;

CREATE TRIGGER commands_are_immutable
BEFORE UPDATE ON commands
BEGIN
    SELECT RAISE(ABORT, 'commands are immutable');
END;

CREATE TRIGGER commands_cannot_be_deleted
BEFORE DELETE ON commands
BEGIN
    SELECT RAISE(ABORT, 'commands cannot be deleted');
END;

CREATE TRIGGER terminal_exports_are_immutable
BEFORE UPDATE ON terminal_exports
BEGIN
    SELECT RAISE(ABORT, 'terminal exports are immutable');
END;

CREATE TRIGGER terminal_exports_cannot_be_deleted
BEFORE DELETE ON terminal_exports
BEGIN
    SELECT RAISE(ABORT, 'terminal exports cannot be deleted');
END;
