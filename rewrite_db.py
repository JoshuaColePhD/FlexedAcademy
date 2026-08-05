import re

with open("backend/db.py", "r") as f:
    code = f.read()

code = code.replace("import sqlite3", "import psycopg2\nfrom psycopg2.extras import RealDictCursor\nfrom pgvector.psycopg2 import register_vector")
code = code.replace("sqlite3.Connection", "psycopg2.extensions.connection")
code = code.replace("sqlite3.Row", "dict")
code = code.replace("sqlite3.Cursor", "psycopg2.extensions.cursor")
code = code.replace("conn = sqlite3.connect(str(path), check_same_thread=False)", "pass")

_write_new = """def _write(sql: str, params: tuple = ()) -> psycopg2.extensions.cursor:
    conn = connect()
    with _lock:
        with conn.cursor() as cur:
            # psycopg2 uses %s for placeholders instead of ?
            cur.execute(sql.replace("?", "%s"), params)
        conn.commit()
        return cur
"""
code = re.sub(r'def _write\(sql: str, params: tuple = \(\)\) -> .*?:\n(?:    .*\n)*', _write_new, code)

_rows_new = """def _rows(sql: str, params: tuple = ()) -> list[dict]:
    conn = connect()
    with _lock:
        with conn.cursor() as cur:
            cur.execute(sql.replace("?", "%s"), params)
            return [dict(r) for r in cur.fetchall()]
"""
code = re.sub(r'def _rows\(sql: str, params: tuple = \(\)\) -> .*?:\n(?:    .*\n)*', _rows_new, code)

_row_new = """def _row(sql: str, params: tuple = ()) -> dict | None:
    conn = connect()
    with _lock:
        with conn.cursor() as cur:
            cur.execute(sql.replace("?", "%s"), params)
            r = cur.fetchone()
            return dict(r) if r else None
"""
code = re.sub(r'def _row\(sql: str, params: tuple = \(\)\) -> .*?:\n(?:    .*\n)*', _row_new, code)

connect_new = """def connect() -> psycopg2.extensions.connection:
    global _conn
    if _conn is not None and not _conn.closed:
        return _conn
    if not settings.database_url:
        raise ValueError("DATABASE_URL is not set in .env")
    
    conn = psycopg2.connect(settings.database_url, cursor_factory=RealDictCursor)
    conn.autocommit = False
    
    try:
        register_vector(conn)
    except psycopg2.ProgrammingError:
        pass
        
    _conn = conn
    migrate(conn)
    log.info("db connected to Supabase")
    return conn
"""
code = re.sub(r'def connect\(\) -> .*?:\n(?:    .*\n)*', connect_new, code)

close_new = """def close() -> None:
    global _conn
    if _conn is not None:
        if not _conn.closed:
            _conn.close()
        _conn = None
"""
code = re.sub(r'def close\(\) -> None:\n(?:    .*\n)*', close_new, code)

migrate_new = """def migrate(conn: psycopg2.extensions.connection) -> None:
    with conn.cursor() as cur:
        cur.execute('''
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY
            )
        ''')
        cur.execute('SELECT MAX(version) FROM schema_version')
        version_row = cur.fetchone()
        version = version_row['max'] if version_row and version_row['max'] is not None else 0
        
        for i, script in enumerate(MIGRATIONS[version:], start=version):
            log.info("applying migration %d", i + 1)
            with _lock:
                cur.execute(script)
                cur.execute("INSERT INTO schema_version (version) VALUES (%s) ON CONFLICT (version) DO NOTHING", (i + 1,))
                conn.commit()
                
        # Register vector extension now that it is created
        register_vector(conn)
"""
code = re.sub(r'def migrate\(conn: .*?\) -> None:\n(?:    .*\n)*', migrate_new, code)

new_migrations = """MIGRATIONS: list[str] = [
    \"\"\"
    CREATE TABLE settings (
      id         SERIAL PRIMARY KEY,
      teacher    TEXT NOT NULL DEFAULT 'Josh Cole',
      course     TEXT NOT NULL DEFAULT 'AP Language & Composition',
      period     TEXT NOT NULL DEFAULT '3rd period',
      updated_at TEXT NOT NULL,
      CHECK (id = 1)
    );
    CREATE TABLE chats (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE plans (
      id            TEXT PRIMARY KEY,
      created_at    TEXT NOT NULL,
      course        TEXT NOT NULL,
      week_label    TEXT NOT NULL,
      unit          TEXT,
      query         TEXT NOT NULL,
      plan_json     TEXT NOT NULL,
      docx_path     TEXT,
      retrieved_ids TEXT,
      warnings      TEXT,
      chat_id       TEXT REFERENCES chats(id) ON DELETE SET NULL,
      template      TEXT NOT NULL DEFAULT 'florence-docx-v2'
    );
    CREATE INDEX idx_plans_created ON plans(created_at DESC);
    CREATE TABLE messages (
      id         SERIAL PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content    TEXT NOT NULL,
      plan_id    TEXT REFERENCES plans(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_messages_chat ON messages(chat_id, id);
    \"\"\",
    \"\"\"
    ALTER TABLE settings ADD COLUMN subject TEXT NOT NULL DEFAULT 'AP Language & Composition';
    ALTER TABLE settings ADD COLUMN grade TEXT NOT NULL DEFAULT '11';
    \"\"\",
    \"\"\"
    CREATE TABLE settings_new (
      subject    TEXT PRIMARY KEY,
      teacher    TEXT NOT NULL,
      course     TEXT NOT NULL,
      period     TEXT NOT NULL,
      grade      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO settings_new (subject, teacher, course, period, grade, updated_at)
    SELECT subject, teacher, course, period, grade, updated_at FROM settings;
    DROP TABLE settings;
    ALTER TABLE settings_new RENAME TO settings;
    \"\"\",
    \"\"\"
    CREATE TABLE curriculum_maps (
      id           TEXT PRIMARY KEY,
      subject      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_path  TEXT NOT NULL,
      chars        INTEGER NOT NULL DEFAULT 0,
      active       INTEGER NOT NULL DEFAULT 1,
      uploaded_at  TEXT NOT NULL
    );
    CREATE INDEX idx_curriculum_maps_subject ON curriculum_maps(subject, active);
    CREATE TABLE curriculum_progress (
      id           TEXT PRIMARY KEY,
      map_id       TEXT NOT NULL REFERENCES curriculum_maps(id) ON DELETE CASCADE,
      subject      TEXT NOT NULL,
      sort_order   INTEGER NOT NULL,
      unit         TEXT,
      week_label   TEXT,
      target_start TEXT,
      target_end   TEXT,
      standards    TEXT,
      notes        TEXT
    );
    CREATE INDEX idx_curriculum_progress_map ON curriculum_progress(map_id, sort_order);
    \"\"\",
    \"\"\"
    CREATE TABLE settings_v5 (
      user_id    TEXT NOT NULL,
      subject    TEXT NOT NULL,
      teacher    TEXT NOT NULL,
      course     TEXT NOT NULL,
      period     TEXT NOT NULL,
      grade      TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, subject)
    );
    INSERT INTO settings_v5 (user_id, subject, teacher, course, period, grade, updated_at)
    SELECT 'default_user', subject, teacher, course, period, grade, updated_at FROM settings;
    DROP TABLE settings;
    ALTER TABLE settings_v5 RENAME TO settings;
    ALTER TABLE chats ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_user';
    ALTER TABLE plans ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_user';
    \"\"\",
    \"\"\"
    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT,
      created_at    TEXT NOT NULL
    );
    INSERT INTO users (id, email, name, password_hash, created_at)
    VALUES ('default_user', 'jpcole@florencek12.org', 'Josh Cole', NULL, '2024-01-01T00:00:00+00:00');
    ALTER TABLE curriculum_maps ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_user';
    ALTER TABLE curriculum_progress ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_user';
    CREATE INDEX idx_curriculum_maps_user ON curriculum_maps(user_id, subject, active);
    CREATE INDEX idx_curriculum_progress_user ON curriculum_progress(user_id, subject);
    CREATE INDEX idx_chats_user ON chats(user_id);
    CREATE INDEX idx_plans_user ON plans(user_id);
    \"\"\",
    \"\"\"
    CREATE TABLE plan_feedback (
      id         SERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL,
      plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      is_good    INTEGER NOT NULL CHECK(is_good IN (0, 1)),
      notes      TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_plan_feedback_plan ON plan_feedback(plan_id);
    \"\"\",
    \"\"\"
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE chunks (
      id          TEXT PRIMARY KEY,
      document    TEXT NOT NULL,
      metadata    JSONB,
      embedding   vector(384)
    );
    CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
    \"\"\"
]
"""
code = re.sub(r'MIGRATIONS: list\[str\] = \[\n(?:.*\n)*?\]\n', new_migrations, code)

code = code.replace("INSERT OR IGNORE INTO chats", "INSERT INTO chats")
code = code.replace(
    "VALUES (?,?,?,?,?)",
    "VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING"
)
code = code.replace("ON CONFLICT(user_id, subject) DO UPDATE SET", "ON CONFLICT(user_id, subject) DO UPDATE SET")

code = code.replace("cur.lastrowid", "0") # add_message lastrowid is unused by callers

with open("backend/db_pg.py", "w") as f:
    f.write(code)

import os
os.replace("backend/db_pg.py", "backend/db.py")
