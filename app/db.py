import json
from contextlib import contextmanager
import psycopg
from psycopg.rows import dict_row
from app.config import get_settings

@contextmanager #context manager to get a database connection 
def get_db_connection():
    settings = get_settings()
    #external db url from render
    url = settings.postgres_database_url
    if not url:
        raise RuntimeError("DATABASE_url is missing from .env")
    with psycopg.connect(url, row_factory=dict_row, connect_timeout=10) as conn:
        yield conn

def audit(conn, actor, tenant, action, detail): #function to audit database changes
    conn.execute("INSERT INTO audit (actor, tenant, action, detail) VALUES (%s, %s, %s, %s)", 
                 (actor, tenant, action, detail))