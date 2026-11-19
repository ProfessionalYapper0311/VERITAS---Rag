# Veritas RAG — Setup & Operations Guide

A comprehensive, step-by-step operational guide for setting up, configuring, and running the **Veritas** multi-tenant document intelligence and Retrieval-Augmented Generation (RAG) platform.

---

## 1. Prerequisites

Before installing the application, ensure you have the following environments and service accounts ready:

- **Python Runtime**: Python `3.13` or higher (compatible with `uv` package manager).
- **PostgreSQL Database**: A managed or local PostgreSQL instance (e.g., Render Cloud, Supabase, or AWS RDS).
- **AWS Account**:
  - An S3 bucket (e.g., `veritas--ragbucket-26`) with direct browser upload permissions.
  - AWS Bedrock model access granted for:
    - **LLM Generation**: `amazon.nova-lite-v1:0`
    - **Embeddings**: `amazon.titan-embed-text-v2:0` (1024 dimensions)
- **Pinecone Account**: Serverless index access on AWS (`us-east-1`).
- **GlassFlow Rius** *(Optional)*: API key for privacy-first agent observability and tracing.

---

## 2. Environment Setup

### Option A: Using `uv` (Recommended)

`uv` provides fast, deterministic dependency resolution.

```bash
# 1. Clone the repository and navigate to the project root
git clone <repository-url>
cd VERITAS---Rag

# 2. Create the virtual environment pinned to Python 3.13
uv venv --python 3.13

# 3. Activate the virtual environment
# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# macOS / Linux:
source .venv/bin/activate

# 4. Install project dependencies
uv pip install -r requirements.txt
```

### Option B: Using Standard Python `venv` & `pip`

```bash
# 1. Create a virtual environment
python -m venv .venv

# 2. Activate the virtual environment
# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# macOS / Linux:
source .venv/bin/activate

# 3. Upgrade pip and install dependencies
pip install --upgrade pip
pip install -r requirements.txt
```

---

## 3. Configuration (`.env`)

Copy the template file `.env.example` to create your local `.env`:

```bash
# Windows (PowerShell):
Copy-Item .env.example .env
# macOS / Linux:
cp .env.example .env
```

Open `.env` and fill in your credentials:

```dotenv
# ==============================================================================
# AWS & Storage Configuration
# ==============================================================================
AWS_ACCESS_KEY_ID="your_aws_access_key_id"
AWS_SECRET_ACCESS_KEY="your_aws_secret_access_key"
AWS_REGION="us-east-1"
your_s3_bucket_name="veritas--ragbucket-26"

# ==============================================================================
# Foundation Models (AWS Bedrock)
# ==============================================================================
BEDROCK_CHAT_MODEL="amazon.nova-lite-v1:0"
BEDROCK_EMBED_MODEL="amazon.titan-embed-text-v2:0"
EMBED_DIMENSION=1024

# ==============================================================================
# Pinecone Vector Database
# ==============================================================================
PINECONE_API_KEY="your_pinecone_api_key"
PINECONE_INDEX_NAME="veritas--rag-index"
PINECONE_CLOUD="aws"
PINECONE_REGION="us-east-1"
PINECONE_READY_TIMEOUT=180

# ==============================================================================
# PostgreSQL Database (Render Cloud / Managed DB)
# ==============================================================================
POSTGRES_DATABASE_URL="postgresql://user:password@host/dbname?sslmode=require"

# ==============================================================================
# GlassFlow Rius Observability (Optional)
# ==============================================================================
RIUS_API_KEY="your_rius_api_key"
RIUS_SERVICE_NAME="veritas--rag"
RIUS_DISABLED=false
RIUS_CAPTURE_CONTENT=false
```

### Configuration Parameters Reference

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `AWS_REGION` | AWS region hosting S3 and Bedrock | `us-east-1` |
| `your_s3_bucket_name` | S3 bucket for uploaded files | `veritas--ragbucket-26` |
| `BEDROCK_CHAT_MODEL` | Fast, low-latency reasoning LLM | `amazon.nova-lite-v1:0` |
| `BEDROCK_EMBED_MODEL`| Embedding model generating 1024-dim vectors | `amazon.titan-embed-text-v2:0` |
| `PINECONE_INDEX_NAME`| Pinecone serverless vector index | `veritas--rag-index` |
| `POSTGRES_DATABASE_URL`| PostgreSQL connection string | `postgresql://...` |
| `RIUS_CAPTURE_CONTENT`| Privacy toggle; set `false` to avoid sending content | `false` |

---

## 4. Database & Storage Initialization

### Step 1: Initialize PostgreSQL Tables
Run the database initialization script to execute `infra/schema.sql`. It creates the required relational tables with tenant indexes:

```bash
python scripts/init_db.py
```

**Created Tables:**
- `documents`: Document metadata, S3 storage keys, access control groups, and processing status (`pending`, `processing`, `ready`, `failed`).
- `chat_messages`: Multi-turn conversational memory indexed by `tenant_id` and `conversation_id`.
- `approvals`: Human-In-The-Loop approval requests for sensitive operations.
- `audit_events`: Immutable audit trail of uploads, guardrail blocks, and approval decisions.
- `feedback`: User satisfaction ratings (-1 to 1) and evaluation notes.

> **Note**: `scripts/init_db.py` uses `CREATE TABLE IF NOT EXISTS` and is completely idempotent—safe to rerun anytime without affecting existing records.

---

### Step 2: Configure S3 CORS Policy
Veritas uses direct client-to-S3 uploads via presigned URLs to avoid streaming heavy files through the web server. For uploads to succeed from your browser, configure CORS on your AWS S3 bucket:

1. In the **AWS S3 Console**, open your bucket (`veritas--ragbucket-26`).
2. Go to the **Permissions** tab and scroll to **Cross-origin resource sharing (CORS)**.
3. Paste the following configuration and save:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedOrigins": [
      "http://localhost:8000",
      "http://127.0.0.1:8000"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## 5. Running the Application

### Start the FastAPI Server

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### Accessing the System

| Interface | URL | Description |
| :--- | :--- | :--- |
| **Web Application** | [http://localhost:8000/](http://localhost:8000/) | Full interactive UI (Chat, Library, Approvals, Admin) |
| **Interactive API Docs**| [http://localhost:8000/api/docs](http://localhost:8000/api/docs) | Swagger UI for testing REST endpoints |
| **Liveness Check** | [http://localhost:8000/health/live](http://localhost:8000/health/live) | Basic process liveness probe |
| **Readiness Check** | [http://localhost:8000/health/ready](http://localhost:8000/health/ready) | Verifies active PostgreSQL connectivity |

---

## 6. Document Ingestion Workflow

1. **Upload**: Select a `.pdf`, `.docx`, `.txt`, or `.md` file in the Web UI.
2. **Presigned URL**: The backend generates a secure S3 PUT URL (`POST /api/documents/uploads`).
3. **Direct Upload**: The browser PUTs the file directly to S3.
4. **Ingestion Worker**:
   - `worker/ingest.py` reads the file, parses text and page numbers, and divides it into chunks (1,000 characters with 180-character overlap).
   - Generates 1,024-dimensional normalized vector embeddings using Amazon Titan v2.
   - Upserts vectors into the tenant's isolated Pinecone namespace (`tenant-{tenant_id}`).
   - Updates document status in PostgreSQL to `ready`.

---

## 7. Human-In-The-Loop (HITL) & Deletion CLI

### Deletion via Chat Prompt
When a user asks:
- *"delete all documents in your database"*
- *"remove document confidential_memo.txt"*

The backend intercepts the request, blocks execution, and creates an approval request (`POST /api/approvals`). Once an administrator reviews and approves it in the **Approvals** tab, the system automatically purges the records from PostgreSQL, wipes the Pinecone vectors, and deletes the files from AWS S3.

### Deletion via Command-Line Interface (CLI)
You can also run administrative deletions directly from your terminal:

```bash
# Delete all documents for the default tenant (demo-workspace)
python -m app.deletion --all

# Delete a specific document by title or UUID
python -m app.deletion --document "sample_report.pdf"

# Specify a custom tenant or actor
python -m app.deletion --tenant "enterprise-workspace" --document "contract.docx" --actor "security-admin"
```

---

## 8. Verification & Test Suites

Run the automated test suites to ensure all database connections, guardrails, and ingestion pathways are operating properly:

```bash
# 1. Run the comprehensive system test suite (Config, DB, Guardrails, Health, UI templates)
python -m unittest tests/comprehensive_test.py

# 2. Run the HITL and multi-tier deletion test suite (PostgreSQL, Pinecone, S3)
python -m unittest tests/test_deletion.py

# 3. Print the LangGraph ASCII execution graph
python tests/show_graph.py
```

---

## 9. Troubleshooting & FAQ

### 1. `ValidationException: Operation not allowed` on AWS Bedrock
- **Cause**: New AWS accounts or certain regions may have an operational hold or require explicit foundation model access.
- **Solution**: Open the AWS Bedrock Console, navigate to **Model access**, and ensure `Amazon Nova Lite` and `Amazon Titan Embeddings G1 - Text` are granted. Alternatively, reference the migration guides in the repository for Google Gemini or Mistral.

### 2. S3 Upload CORS Errors in the Browser
- **Cause**: The browser blocked the direct PUT request because the S3 bucket does not have CORS enabled for `http://localhost:8000`.
- **Solution**: Follow [Step 2 in Section 4](#step-2-configure-s3-cors-policy) to apply the CORS JSON policy to your S3 bucket.

### 3. Pinecone Dimension Mismatch
- **Cause**: If an existing Pinecone index was created with 1,536 dimensions (OpenAI standard) instead of 1,024 dimensions.
- **Solution**: Veritas requires `1024` dimensions and `cosine` distance metric. Ensure your `PINECONE_INDEX_NAME` in `.env` is set to a 1024-dimension index (or allow Veritas to auto-create it).

### 4. PostgreSQL Connection Timeout
- **Cause**: If using a free-tier Render PostgreSQL instance, the database may take 15–30 seconds to wake up from an idle state.
- **Solution**: Verify the database URL in `.env` includes `?sslmode=require` and retry running `python scripts/init_db.py`.
