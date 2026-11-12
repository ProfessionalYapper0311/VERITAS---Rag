import uuid
from app.db import get_db_connection
from app.config import get_settings

def history(tenant: str, conversation_id: uuid.UUID):
    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT role, content FROM(
            SELECT id, role, content, created_at FROM chat_messages
            WHERE tenant_id=%s AND conversation_id=%s ORDER BY id DESC LIMIT %s)
            recent ORDER BY id ASC
            """,
            (tenant, conversation_id, get_settings().memory_turns*2))
    return rows

#helper func to save any convo
def save_turn(tenant:str, conversation_id: uuid.UUID, question:str, response:str):
    with get_db_connection() as conn:
        conn.execute("""
            INSERT INTO chat_messages(tenant_id, conversation_id, role, content)
            VALUES(%s, %s, 'user', %s), (%s, %s, 'assistant', %s)
            """)

#list all the messages for a given conversation
def list_messages(tenant: str, conversation_id: uuid.UUID):
    with get_db_connection() as conn:
        return conn.execute(
            """
            SELECT role, content, created_at FROM chat_messages
            WHERE tenant_id=%s AND conversation_id=%s ORDER BY id ASC LIMIT 100
            """,
            (tenant, conversation_id)).fetchall()


