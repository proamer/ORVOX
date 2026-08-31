import { Database } from "bun:sqlite";

export type Row = {
  id: number;
  title: string;
  state: string;
  points: number | null;
  created_at: number;
};

export const db = new Database(process.env.TASKS_DB ?? ":memory:", { create: true });
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    state      TEXT NOT NULL DEFAULT 'todo',
    points     INTEGER,
    created_at INTEGER NOT NULL
  );
`);

export const q = {
  insert: db.query<Row, [string, string, number | null, number]>(
    "INSERT INTO tasks (title, state, points, created_at) VALUES (?, ?, ?, ?) RETURNING *",
  ),
  byId: db.query<Row, [number]>("SELECT * FROM tasks WHERE id = ?"),
  page: db.query<Row, [string, number, number]>(
    "SELECT * FROM tasks WHERE (?1 = '' OR state = ?1) ORDER BY id LIMIT ?2 OFFSET ?3",
  ),
  setState: db.query<Row, [string, number]>(
    "UPDATE tasks SET state = ? WHERE id = ? RETURNING *",
  ),
  remove: db.query<void, [number]>("DELETE FROM tasks WHERE id = ?"),
};
