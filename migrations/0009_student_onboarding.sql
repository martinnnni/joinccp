ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1));
DELETE FROM invites WHERE role='student' AND used_by IS NULL;
