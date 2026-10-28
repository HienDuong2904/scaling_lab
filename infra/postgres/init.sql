-- Runs once, when the Postgres volume is first created (make nuke && make up to rerun).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector, Project 10
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram search, Project 8
