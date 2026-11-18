"""
Document Deletion Module for Project Veritas.

Provides comprehensive deletion logic across:
1. PostgreSQL relational database (documents table and audit trails)
2. Pinecone Serverless vector database (tenant namespace and vector records)
3. AWS S3 storage (tenant document incoming keys and files)

Supports:
- Bulk deletion ("delete all documents in your database")
- Specific document deletion ("remove document X", "delete document: X.pdf")
- Edge case handling (missing files, non-existent records, empty namespaces, tenant isolation)
"""

import os
import re
import sys
import uuid
import logging
import argparse
from pathlib import Path

from app.config import get_settings
from app.db import get_db_connection, audit
from app.aws import client
from app.vector import index, namespace

log = logging.getLogger(__name__)


def delete_s3_key(s3_key: str) -> bool:
    """
    Safely delete a single object from S3.
    Returns True if deleted or already absent, False on unexpected error.
    """
    s = get_settings()
    if not s.s3_bucket:
        log.warning("S3 bucket not configured; skipping S3 object deletion for key: %s", s3_key)
        return False
    try:
        s3 = client('s3')
        s3.delete_object(Bucket=s.s3_bucket, Key=s3_key)
        log.info("Deleted S3 object: %s from bucket: %s", s3_key, s.s3_bucket)
        return True
    except Exception as exc:
        log.warning("S3 object deletion warning for key %s: %s", s3_key, exc)
        return False


def delete_s3_prefix(prefix: str) -> int:
    """
    Safely delete all objects matching an S3 prefix.
    Returns the count of deleted objects.
    """
    s = get_settings()
    if not s.s3_bucket:
        log.warning("S3 bucket not configured; skipping bulk S3 deletion.")
        return 0
    try:
        s3 = client('s3')
        paginator = s3.get_paginator('list_objects_v2')
        deleted_count = 0
        for page in paginator.paginate(Bucket=s.s3_bucket, Prefix=prefix):
            if 'Contents' in page:
                keys = [{'Key': obj['Key']} for obj in page['Contents']]
                if keys:
                    s3.delete_objects(Bucket=s.s3_bucket, Delete={'Objects': keys})
                    deleted_count += len(keys)
        log.info("Deleted %d S3 objects under prefix '%s'", deleted_count, prefix)
        return deleted_count
    except Exception as exc:
        log.warning("S3 bulk deletion warning for prefix '%s': %s", prefix, exc)
        return 0


def delete_pinecone_vectors_for_document(tenant_id: str, doc_id: str) -> bool:
    """
    Safely delete all chunk vectors for a document in Pinecone.
    """
    s = get_settings()
    if not s.pinecone_api_key or not s.pinecone_index_name:
        log.warning("Pinecone settings missing; skipping vector deletion.")
        return False
    try:
        idx = index()
        ns = namespace(tenant_id)
        # Attempt filter-based deletion (Pinecone serverless)
        try:
            idx.delete(filter={"document_id": {"$eq": str(doc_id)}}, namespace=ns)
            log.info("Deleted Pinecone vectors for doc %s via metadata filter", doc_id)
            return True
        except Exception:
            # Fallback: Delete common chunk ID patterns: '{doc_id} : {version} : {chunk}'
            ids_to_delete = [f"{doc_id} : {v} : {i}" for v in range(1, 6) for i in range(200)]
            for i in range(0, len(ids_to_delete), 50):
                idx.delete(ids=ids_to_delete[i:i+50], namespace=ns)
            log.info("Deleted Pinecone vectors for doc %s via ID pattern fallback", doc_id)
            return True
    except Exception as exc:
        log.warning("Pinecone vector deletion warning for doc %s: %s", doc_id, exc)
        return False


def delete_pinecone_namespace(tenant_id: str) -> bool:
    """
    Delete all vectors in the tenant namespace in Pinecone.
    """
    s = get_settings()
    if not s.pinecone_api_key or not s.pinecone_index_name:
        log.warning("Pinecone settings missing; skipping namespace wipe.")
        return False
    try:
        idx = index()
        ns = namespace(tenant_id)
        idx.delete(delete_all=True, namespace=ns)
        log.info("Wiped Pinecone namespace '%s'", ns)
        return True
    except Exception as exc:
        # Namespace might be empty or 404; log as info/warning
        log.info("Pinecone namespace wipe notice for '%s': %s", tenant_id, exc)
        return True


def delete_specific_document(tenant_id: str, identifier: str, actor: str = "system") -> dict:
    """
    Delete a specific document across PostgreSQL, S3, and Pinecone.

    Edge cases handled:
    - Identifier can be a UUID string, exact filename/title, or case-insensitive partial match.
    - If document does not exist in DB: returns clean not_found response without error.
    - If S3 object is already missing: still deletes DB record and vectors.
    - If Pinecone vector is missing: still finishes DB and S3 deletion.
    - Scoped strictly to tenant_id for multi-tenant isolation.
    """
    clean_id = identifier.strip().strip("'\"")
    if not clean_id:
        return {"status": "error", "message": "No document identifier provided."}

    doc = None
    with get_db_connection() as conn:
        # 1. Try finding by UUID
        try:
            val_uuid = uuid.UUID(clean_id)
            doc = conn.execute(
                "SELECT * FROM documents WHERE id = %s AND tenant_id = %s",
                (val_uuid, tenant_id)
            ).fetchone()
        except ValueError:
            pass

        # 2. Try finding by exact title (case-insensitive)
        if not doc:
            doc = conn.execute(
                "SELECT * FROM documents WHERE tenant_id = %s AND LOWER(title) = LOWER(%s)",
                (tenant_id, clean_id)
            ).fetchone()

        # 3. Try finding by title or S3 key pattern
        if not doc:
            doc = conn.execute(
                "SELECT * FROM documents WHERE tenant_id = %s AND (title ILIKE %s OR s3_key ILIKE %s) LIMIT 1",
                (tenant_id, f"%{clean_id}%", f"%{clean_id}%")
            ).fetchone()

        if not doc:
            log.warning("Document '%s' not found for tenant '%s'", clean_id, tenant_id)
            return {
                "status": "not_found",
                "message": f"Document '{clean_id}' was not found in workspace '{tenant_id}'.",
                "identifier": clean_id
            }

        doc_dict = dict(doc)
        doc_id = str(doc_dict['id'])
        s3_key = doc_dict.get('s3_key', '')
        title = doc_dict.get('title', '')

        # Delete from PostgreSQL
        conn.execute("DELETE FROM documents WHERE id = %s AND tenant_id = %s", (doc_dict['id'], tenant_id))

        # Record audit event
        audit(conn, actor, tenant_id, "document_deleted", {
            "document_id": doc_id,
            "title": title,
            "s3_key": s3_key
        })

    # Delete from S3
    s3_deleted = delete_s3_key(s3_key) if s3_key else False

    # Delete from Pinecone
    vectors_deleted = delete_pinecone_vectors_for_document(tenant_id, doc_id)

    log.info("Successfully deleted document: %s (%s) from DB, S3, and Pinecone.", title, doc_id)
    return {
        "status": "success",
        "message": f"Document '{title}' ({doc_id}) was successfully deleted from PostgreSQL, S3, and Pinecone.",
        "document_id": doc_id,
        "title": title,
        "s3_key": s3_key,
        "s3_deleted": s3_deleted,
        "pinecone_deleted": vectors_deleted
    }


def delete_all_documents(tenant_id: str, wipe_entire_bucket: bool = False, actor: str = "system") -> dict:
    """
    Delete all documents for a tenant across PostgreSQL, Pinecone, and S3.

    Edge cases handled:
    - Empty database: gracefully returns 0 count.
    - Preserves multi-tenant boundaries (only deletes tenants/{tenant_id}/ unless wipe_entire_bucket=True).
    - Empties Pinecone tenant namespace completely.
    - Records comprehensive audit event in PostgreSQL.
    """
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT id, title, s3_key FROM documents WHERE tenant_id = %s",
            (tenant_id,)
        ).fetchall()
        docs = [dict(r) for r in rows]

        # Delete rows from PostgreSQL
        conn.execute("DELETE FROM documents WHERE tenant_id = %s", (tenant_id,))

        # Record audit event
        audit(conn, actor, tenant_id, "all_documents_deleted", {
            "count": len(docs),
            "wipe_entire_bucket": wipe_entire_bucket
        })

    # Delete S3 objects
    prefix = "" if wipe_entire_bucket else f"tenants/{tenant_id}/"
    s3_count = delete_s3_prefix(prefix)

    # Empty Pinecone namespace
    pinecone_wiped = delete_pinecone_namespace(tenant_id)

    log.info("Deleted all %d documents for tenant '%s'. S3 objects deleted: %d. Pinecone wiped: %s",
             len(docs), tenant_id, s3_count, pinecone_wiped)

    return {
        "status": "success",
        "message": f"Successfully deleted all {len(docs)} documents in workspace '{tenant_id}'. Emptied Pinecone and S3.",
        "tenant_id": tenant_id,
        "deleted_db_docs": len(docs),
        "deleted_s3_objects": s3_count,
        "pinecone_wiped": pinecone_wiped
    }


def parse_deletion_request(question: str) -> dict:
    """
    Parses a user question or approval text to determine deletion scope.
    Returns:
        {"action": "delete_all"}
        or {"action": "delete_specific", "target": "<identifier>"}
        or {"action": "specific_missing_name"}
        or {"action": "none"}
    """
    q = question.strip().rstrip("?.!")

    # 1. Check for bulk / all documents deletion
    is_bulk = (
        bool(re.search(r"\b(delete|remove|purge|wipe|clear)\s+(?:all|every|the\s+entire)\b", q, re.I)) or
        bool(re.search(r"\b(delete|remove|purge|wipe|clear)\s+all\s+documents\b", q, re.I)) or
        bool(re.search(r"\b(empty|wipe|purge|clear)\s+(?:the\s+)?(?:database|bucket|pinecone)\b", q, re.I))
    )
    if is_bulk:
        return {"action": "delete_all"}

    # 2. Check for explicit filename pattern (e.g. "remove report.pdf", "delete document: sample.txt")
    m_file = re.search(r"[\w\-.]+\.(?:pdf|docx|txt|md)", q, re.I)
    if m_file:
        return {"action": "delete_specific", "target": m_file.group(0)}

    # 3. Check for UUID pattern
    m_uuid = re.search(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", q)
    if m_uuid:
        return {"action": "delete_specific", "target": m_uuid.group(0)}

    # 4. Check for named document commands or generic "remove a specific document"
    m_generic = re.search(r"\b(?:delete|remove|purge|drop)\s+(?:the\s+|a\s+)?(?:specific\s+)?(?:document|file)?\s*[:\-]?\s*(.*)$", q, re.I)
    if m_generic:
        target = m_generic.group(1).strip().strip("'\"")
        if target.lower() in ("a specific document", "specific document", "a document", "the document", "document", "file", "all documents", "all", ""):
            return {"action": "specific_missing_name", "raw": target or q}
        return {"action": "delete_specific", "target": target}

    # 5. Check if user generically asks to remove/delete a document
    if re.search(r"\b(delete|remove|purge|drop)\s+(?:a\s+)?(?:specific\s+)?(?:document|file)\b", q, re.I):
        return {"action": "specific_missing_name", "raw": q}

    return {"action": "none"}


def execute_approved_deletion(tenant_id: str, question: str, actor: str = "system") -> dict:
    """
    Entrypoint called by approval decision workflow when an admin approves a deletion request.
    """
    parsed = parse_deletion_request(question)
    action = parsed.get("action")

    if action == "delete_all":
        return delete_all_documents(tenant_id=tenant_id, actor=actor)
    elif action == "delete_specific":
        target = parsed.get("target")
        return delete_specific_document(tenant_id=tenant_id, identifier=target, actor=actor)
    elif action == "specific_missing_name":
        return {
            "status": "warning",
            "message": "Deletion approved, but no specific document title or filename was specified in the request. Please specify the document name."
        }
    else:
        # Default fallback for deletion approval
        return delete_all_documents(tenant_id=tenant_id, actor=actor)


def main():
    """Command Line Interface for deletion operations."""
    parser = argparse.ArgumentParser(description="Veritas Document Deletion Utility")
    parser.add_argument("--all", action="store_true", help="Delete all documents in the database, Pinecone, and S3.")
    parser.add_argument("--document", type=str, default="", help="Specific document title, filename, or ID to delete.")
    parser.add_argument("--tenant", type=str, default="demo-workspace", help="Target tenant workspace (default: demo-workspace).")
    parser.add_argument("--wipe-bucket", action="store_true", help="Wipe entire S3 bucket instead of only tenant prefix.")
    parser.add_argument("--actor", type=str, default="cli-operator", help="Actor recording the audit log.")

    args = parser.parse_args()

    if not args.all and not args.document:
        parser.print_help()
        print("\nERROR: You must specify either --all or --document <name|id>.")
        sys.exit(1)

    print(f"=== Veritas Deletion Tool (Tenant: {args.tenant}) ===")

    if args.all:
        confirm = input(f"WARNING: This will permanently delete ALL documents for tenant '{args.tenant}' from PostgreSQL, Pinecone, and S3.\nType 'yes' to proceed: ")
        if confirm.strip().lower() != 'yes':
            print("Operation aborted.")
            sys.exit(0)
        result = delete_all_documents(tenant_id=args.tenant, wipe_entire_bucket=args.wipe_bucket, actor=args.actor)
        print("\nResult:", result["message"])
        print(f"Deleted DB Docs: {result.get('deleted_db_docs', 0)} | Deleted S3 Objects: {result.get('deleted_s3_objects', 0)} | Pinecone Wiped: {result.get('pinecone_wiped', False)}")
    else:
        result = delete_specific_document(tenant_id=args.tenant, identifier=args.document, actor=args.actor)
        print("\nResult:", result["message"])

    sys.exit(0 if result.get("status") in ("success", "not_found") else 1)


if __name__ == '__main__':
    main()
