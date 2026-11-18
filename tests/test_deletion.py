import unittest
import uuid
from fastapi.testclient import TestClient
from dotenv import load_dotenv

load_dotenv(override=True)

from app.main import app, is_hitl_action
from app.db import get_db_connection
from app.deletion import parse_deletion_request, delete_specific_document, delete_all_documents

class TestDeletionAndHITL(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.tenant = "demo-workspace"

    def test_01_hitl_action_detection(self):
        """Test is_hitl_action catches all deletion and removal variants."""
        # Must catch bulk requests
        self.assertTrue(is_hitl_action("delete all documents in your database"))
        self.assertTrue(is_hitl_action("Delete all documents"))
        self.assertTrue(is_hitl_action("remove all documents"))
        self.assertTrue(is_hitl_action("purge all documents"))
        self.assertTrue(is_hitl_action("wipe database"))
        self.assertTrue(is_hitl_action("clear all documents"))

        # Must catch specific document requests
        self.assertTrue(is_hitl_action("remove a specific document"))
        self.assertTrue(is_hitl_action("remove document quarterly_report.pdf"))
        self.assertTrue(is_hitl_action("delete document: policy.docx"))
        self.assertTrue(is_hitl_action("delete file sample.txt"))
        self.assertTrue(is_hitl_action("drop document contract.pdf"))

        # Legitimate questions should not trigger HITL
        self.assertFalse(is_hitl_action("What are our travel reimbursement rules?"))
        self.assertFalse(is_hitl_action("Summarize the vacation policy"))
        print("HITL action detection verified for all deletion variants.")

    def test_02_parse_deletion_request(self):
        """Test parsing of deletion scopes and identifiers."""
        r1 = parse_deletion_request("delete all documents in your database")
        self.assertEqual(r1["action"], "delete_all")

        r2 = parse_deletion_request("remove all documents")
        self.assertEqual(r2["action"], "delete_all")

        r3 = parse_deletion_request("delete document: quarterly_report.pdf")
        self.assertEqual(r3["action"], "delete_specific")
        self.assertEqual(r3["target"], "quarterly_report.pdf")

        r4 = parse_deletion_request("remove document policy.docx")
        self.assertEqual(r4["action"], "delete_specific")
        self.assertEqual(r4["target"], "policy.docx")

        r5 = parse_deletion_request("remove a specific document")
        self.assertEqual(r5["action"], "specific_missing_name")
        print("Deletion request parsing verified.")

    def test_03_chat_hitl_and_approve_all_documents(self):
        """Test asking 'delete all documents in your database' triggers HITL and approval executes deletion."""
        # Step 1: User asks to delete all documents
        r_chat = self.client.post("/api/chat", json={"question": "delete all documents in your database"})
        self.assertEqual(r_chat.status_code, 200)
        data = r_chat.json()
        self.assertEqual(data["status"], "pending_approval")
        self.assertIn("approval_id", data)
        approval_id = data["approval_id"]

        # Step 2: Verify it is in /api/approvals
        r_appr = self.client.get("/api/approvals")
        self.assertEqual(r_appr.status_code, 200)
        approvals = r_appr.json()["approvals"]
        matching = [a for a in approvals if str(a["id"]) == approval_id]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["status"], "pending")

        # Step 3: Admin approves the request
        r_decide = self.client.post(f"/api/approvals/{approval_id}/decision", json={"approve": True})
        self.assertEqual(r_decide.status_code, 200)
        decide_data = r_decide.json()
        self.assertEqual(decide_data["status"], "approved")
        self.assertTrue(decide_data["executed"])
        self.assertIsNotNone(decide_data["execution_result"])
        self.assertEqual(decide_data["execution_result"]["status"], "success")
        print("Delete all documents HITL + execution verified.")

    def test_04_chat_hitl_and_approve_specific_document(self):
        """Test asking to remove a specific document triggers HITL and approval executes deletion."""
        # Insert a dummy document in DB for testing
        test_doc_id = str(uuid.uuid4())
        test_key = f"tenants/{self.tenant}/incoming/{test_doc_id}/v1.txt"
        with get_db_connection() as conn:
            conn.execute(
                """INSERT INTO documents(id, tenant_id, title, owner_sub, allowed_groups, s3_key, status, current_version)
                   VALUES (%s, %s, %s, %s, %s, %s, 'ready', 1)""",
                (test_doc_id, self.tenant, "confidential_memo.txt", "demo-operator", ["workspace"], test_key)
            )

        # Step 1: User asks to delete the specific document
        r_chat = self.client.post("/api/chat", json={"question": "delete document confidential_memo.txt"})
        self.assertEqual(r_chat.status_code, 200)
        data = r_chat.json()
        self.assertEqual(data["status"], "pending_approval")
        approval_id = data["approval_id"]

        # Step 2: Admin approves the deletion
        r_decide = self.client.post(f"/api/approvals/{approval_id}/decision", json={"approve": True})
        self.assertEqual(r_decide.status_code, 200)
        decide_data = r_decide.json()
        self.assertEqual(decide_data["status"], "approved")
        self.assertTrue(decide_data["executed"])
        self.assertEqual(decide_data["execution_result"]["status"], "success")
        self.assertEqual(decide_data["execution_result"]["document_id"], test_doc_id)

        # Step 3: Verify document is gone from PostgreSQL
        with get_db_connection() as conn:
            doc = conn.execute("SELECT * FROM documents WHERE id = %s", (test_doc_id,)).fetchone()
            self.assertIsNone(doc)
        print("Delete specific document HITL + execution verified.")

    def test_05_edge_case_document_not_found(self):
        """Test edge case: approving deletion of non-existent document."""
        res = delete_specific_document(self.tenant, "ghost_document_12345.pdf")
        self.assertEqual(res["status"], "not_found")
        self.assertIn("was not found", res["message"])
        print("Edge case: non-existent document handled cleanly.")

    def test_06_edge_case_empty_database_delete_all(self):
        """Test edge case: delete all documents when 0 documents exist."""
        res = delete_all_documents(self.tenant)
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["deleted_db_docs"], 0)
        print("Edge case: empty database bulk deletion handled cleanly.")


if __name__ == '__main__':
    unittest.main()
