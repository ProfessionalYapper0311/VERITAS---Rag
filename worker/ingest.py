#get data from s3->split into chunks-> embed the data 1024 dim(generate bedrock) -> upsert into vector db pinecone

import io
import logging
from pathlib import Path
from docx import Document
from pypdf import PdfReader

from app.config import get_settings
from app.aws import client, embed
from app.vector import upsert
from app.db import get_db_connection, audit
from app.observability import trace, initialize

initialize() #initialize tracing

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log=logging.getLogger(__name__)

def parse(blob:bytes, suffix: str):
    if suffix == '.pdf':
        reader = PdfReader(io.BytesIO(blob))
        return [(i+1, page.extract_text() or '') for i,page in enumerate(reader.pages)]
    if suffix == '.docx':
        doc=Document(io.BytesIO(blob))
        return[(1, ''.join(p.text for p in doc.paragraphs))]
    return [(1, blob.decode('utf-8'))]

def chunks(text, chunk_size=1000, chunk_overlap=180):
    text = ' '.join(text.split())
    pos = 0
    while pos < len(text):
        yield text[pos:pos+chunk_size]
        if pos+chunk_size > len(text):
            break
        pos += chunk_size - chunk_overlap 

#entire operation inside this given function
@trace("process_s3_key") #trace the process_s3_key operation
def process_s3_key(key):
    s = get_settings()
    with get_db_connection() as conn:
        doc = conn.execute('SELECT * FROM documents WHERE s3_key=%s FOR UPDATE', (key,)).fetchone()
        if not doc or doc['status']=='ready':
            return 
        if doc['status'] not in ('pending', 'failed'):
            return
        conn.execute("UPDATE documents SET status='processing' WHERE id = %s",(doc['id'],))
    try:
        obj = client('s3').get_object(Bucket=s.s3_bucket, Key=key)
        if obj['ContentLength']>s.max_upload_bytes: 
            raise ValueError(f"File {key} exceeds max upload size of {s.max_upload_bytes} bytes")
        
        blob=obj['Body'].read(s.max_upload_bytes+1)
        if len(blob)>s.max_upload_bytes: 
            raise ValueError(f"File {key} exceeds max upload size of {s.max_upload_bytes} bytes")
        
        if Path(key).suffix.lower()=='.pdf' and not blob.startswith(b'%PDF'):
            raise ValueError(f"File {key} is not a valid PDF")

        pages=parse(blob, Path(key).suffix.lower())
        parts=[(page, part) for page,text in pages for part in chunks(text)]
        if not parts:
            raise ValueError(f"File {key} contains no extractable text; scanned PDFs need Textract OCR")
        
        vectors=[]
        for i,(page,part) in enumerate(parts):
            vectors.append({
                'id' : f'{doc["id"]} : {doc["current_version"]} : {i}',
                'values' : embed(part),
                'metadata' : {'document_id' : str(doc['id']),
                              'title' : doc['title'],
                              'page' : page,
                              'text' : part,
                              'owner' : doc['owner_sub'],
                              'allowed_groups' : doc['allowed_groups']
                              }
                            }
            )
        #keep batches small; pinecone metadata must fit the index's limit
        for i in range(0, len(vectors), 50):
            upsert(doc['tenant_id'], vectors[i:i+50])
        with get_db_connection() as conn:
            conn.execute("UPDATE documents SET status= 'ready' WHERE id = %s", (doc['id'],))
            audit(conn,
                  doc['owner_sub'],
                  doc['tenant_id'],
                  'ingest_ready',
                  {'document_id' : str(doc['id']),
                   'chunks':len(parts)})
        log.info(f'Ingested document {doc["id"]} chunks={len(parts)}')
    except Exception:
        log.exception(f'Ingestion failed for key {key}')
        with get_db_connection() as conn:
            conn.execute(f"UPDATE documents SET status='failed' WHERE id = {doc['id']}")
        raise    